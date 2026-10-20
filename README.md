# Brygadzista

Asystent AI dla wykonawcy: agent, który zna projekt techniczny budynku (PDF) i odpowiada na pytania na budowie, z podaniem strony źródłowej. Docelowo także interaktywny model 3D domu w telefonie.

## Architektura

```
apps/server     Node 22 + Hono: API, upload i indeksowanie PDF, agent CopilotKit (AG-UI), serwuje dashboard
apps/dashboard  panel operatora: Vite + React 19, czat CopilotKit z A2UI, upload PDF
apps/mobile     aplikacja Expo (expo-router, @copilotkit/react-native), zob. apps/mobile/README.md
deploy/         (epik) docker compose dla Openship na serwerze ruth154
```

**Indeksowanie PDF** (`apps/server/src/ingest.ts`): PDF jest strumieniowany na dysk, potem w tle strona po stronie: `pdftotext` (tekst), `pdftoppm` (JPEG strony), model z wizją robi ustrukturyzowany indeks strony (tytuł, rodzaj, opis, parametry, słowa kluczowe), a Gemini Embedding 2 liczy wektory (pgvector). Przetwarzanie jest wznawialne po restarcie.

**Duże PDF-y** (setki stron, arkusze A0/A1):
- Upload jest strumieniowany i przerywany po przekroczeniu `MAX_UPLOAD_MB` (413); PDF z więcej niż `MAX_PAGES` stron jest odrzucany.
- Odpowiedź uploadu zawiera `pageCount` i `estimate` (`costUsd`, `seconds`), liczone z `INDEX_COST_PER_PAGE_USD`, `INDEX_SECONDS_PER_PAGE` i `INDEX_CONCURRENCY`. Z `?autostart=0` dokument ma status `awaiting_start` i czeka na `POST /api/documents/:id/start` z dashboardu.
- W trakcie indeksowania `GET /api/documents/:id` (i lista dokumentów) zwraca `progress` (`total`, `done`, `etaSeconds` liczone z dotychczasowego tempa) oraz `failedPages`.
- Każde wywołanie modelu ma timeout (`LLM_TIMEOUT_MS`) i ponowienia z wykładniczym backoffem i jitterem przy 408/429/5xx, timeoutach i zerwanych połączeniach (z respektowaniem `Retry-After`). Wywołania poppler też mają timeout.
- Strona, która mimo ponowień się nie udała, jest zapisywana z błędem i pomijana, a reszta dokumentu idzie dalej (status `ready`, w `error` lista stron do ponowienia). Dopiero `MAX_CONSECUTIVE_PAGE_FAILURES` błędów pod rząd (np. zły klucz, awaria) zatrzymuje dokument.
- `inspect_drawing` na arkuszu większym niż A3 dostaje podgląd całej strony i do 9 nachodzących na siebie kafelków w rozdzielczości do 150 DPI (`drawing.ts`), żeby drobne wymiary były czytelne. Każdy JPEG ma najwyżej 2,5 MB (w razie potrzeby niższa jakość). Kafelki renderują się przy pierwszym użyciu i są cache'owane na dysku.

**Wyszukiwanie** (`search.ts`): hybryda wektorowa (pgvector) + pełnotekstowa z prefiksami i trigramami (polska odmiana), łączona przez reciprocal rank fusion.

**Agent** (`agent.ts`): `BuiltInAgent` CopilotKit z narzędziami `search_project`, `list_pages`, `read_page`, `inspect_drawing`, `show_page`. Odpowiada po polsku i zawsze podaje źródło.

**Katalog A2UI** (`apps/server/src/a2ui-catalog.ts`): komponenty budowlane, które agent może pokazać przez `render_a2ui` obok podstawowego katalogu A2UI: `ParameterCard` (parametr z jednostką i źródłem), `MaterialList` (materiały z ilościami), `WorkSteps` (kroki prac), `LayerComparison` (warstwy przegród obok siebie). Definicje (zod v3, opisy dla modelu) są wspólne: serwer wysyła z nich schemat v0.9 w `a2ui.schema` runtime'u (`a2ui-schema.ts`), a dashboard renderuje je w `apps/dashboard/src/a2uiCatalog.tsx`, a aplikacja mobilna własnym natywnym rendererem (`apps/mobile/src/components/a2ui/`). Oba runtime'y (`/api/copilotkit` i `/api/admin/copilotkit`) mają A2UI. Linki „str. N” w komponentach otwierają stronę projektu.

**Modele i prywatność**: wszystko przez OpenRouter, przypięte do jednego endpointu w UE, bez fallbacku, `data_collection: deny`, `zdr: true` (`llm.ts`).
- rozmowa: `anthropic/claude-opus-5.5` przez `google-vertex/europe`
- indeksowanie stron: `anthropic/claude-sonnet-5.5` przez `google-vertex/europe`
- embeddingi: `google/gemini-embedding-2` przez `google-vertex/eu`

## API (skrót)

| Metoda | Ścieżka | Rola |
| --- | --- | --- |
| GET | `/api/health` | publiczne |
| POST | `/api/auth/login` (`{email, password}` → `{token, expiresAt, role, user}`) | publiczne, limit prób |
| GET | `/api/auth/me` (`{role, user}`, `user` = null dla tokenów z env) | app/admin |
| POST | `/api/auth/logout`, `/api/auth/password` (`{currentPassword, newPassword}`) | app/admin |
| GET/POST | `/api/users`, PATCH/DELETE `/api/users/:id` | admin |
| GET | `/api/projects/:id/members`, PUT/DELETE `/api/projects/:id/members/:userId` | admin |
| GET/POST | `/api/projects` (wykonawca widzi tylko swoje) | app/admin, admin |
| DELETE | `/api/projects/:id` | admin |
| PUT | `/api/projects/:id/documents?filename=&autostart=0` (body = PDF) | admin |
| GET | `/api/projects/:id/documents` | app/admin |
| GET | `/api/documents/:id` (postęp, ETA, szacunek) | app/admin |
| POST | `/api/documents/:id/start` | admin |
| GET | `/api/documents/:id/pages` | app/admin |
| GET | `/api/documents/:id/pages/:n/image` (jedyna ścieżka, która przyjmuje też `?token=`) | app/admin |
| POST | `/api/documents/:id/reindex` | admin |
| * | `/api/copilotkit/*` (nagłówek `x-project-id`) | app/admin |
| * | `/api/admin/copilotkit/*` (z A2UI) | admin |

Autoryzacja: `Authorization: Bearer <token>`.

**Konta** (#10): właściciel (`owner`, rola API `admin`) widzi wszystkie projekty i zarządza kontami; wykonawca (`contractor`, rola API `app`) widzi tylko projekty, do których go dodano (lista projektów, dokumenty, strony, obrazy stron i fabryka agenta; cudzy projekt odpowiada 404). Hasła to argon2id, sesja to losowy token `bs_…` (w bazie tylko jego SHA-256), ważny `SESSION_TTL_DAYS` dni i przedłużany przy użyciu. Wyłączenie konta lub nowe hasło kończy jego sesje.
- `ADMIN_TOKEN` z env działa dalej jako awaryjny dostęp administratora; nim zakłada się pierwsze konto właściciela (`POST /api/users` z `role: "owner"`).
- `APP_TOKEN` to stary wspólny token aplikacji (wszystkie projekty). Jest wyłączony, gdy pusty, a w produkcji (`NODE_ENV=production`) także gdy nieustawiony.
- Limity (w pamięci procesu): uruchomienia agenta `RATE_LIMIT_CHAT_PER_MINUTE` na użytkownika, upload `RATE_LIMIT_UPLOADS_PER_HOUR`, logowanie `RATE_LIMIT_LOGIN_PER_15_MIN` na e-mail (i 5× tyle na IP). Po przekroczeniu 429 z `Retry-After`.

## Lokalnie

```bash
docker run -d -e POSTGRES_USER=brygadzista -e POSTGRES_PASSWORD=brygadzista -e POSTGRES_DB=brygadzista -p 5432:5432 pgvector/pgvector:pg16
pnpm install
cp apps/server/.env.example apps/server/.env   # uzupełnij OPENROUTER_API_KEY
cd apps/server && node --env-file=.env --import tsx src/index.ts
```

Bez klucza OpenRouter czat można testować na skryptowanym agencie: `FAKE_AGENT=1` w `.env`. Odpowiada tymi samymi zdarzeniami AG-UI co prawdziwy agent (tekst, statusy narzędzi, `show_page` z pierwszą stroną projektu, a na pytanie ze słowem „zestawienie” lub „A2UI” także powierzchnię A2UI ze wszystkimi komponentami katalogu budowy). Przy `NODE_ENV=production` flaga jest ignorowana.

Dashboard (dev, proxy `/api` na `localhost:3000`, inny adres przez `API_URL`):

```bash
pnpm --filter @brygadzista/dashboard dev
```

W produkcji `pnpm --filter @brygadzista/dashboard build` tworzy `apps/dashboard/dist`, który serwer wystawia pod `/` (`DASHBOARD_DIR`).

Wymaga `poppler-utils` (`pdfinfo`, `pdftotext`, `pdftoppm`).

## Testy

Testy (`apps/server/test`, vitest) działają na prawdziwym Postgresie z pgvector, a modele (indeksowanie stron, embeddingi) są zamockowane, więc nie potrzebują klucza OpenRouter. Nie ma CI w GitHub Actions: testy uruchamiamy lokalnie i wklejamy wynik do PR.

```bash
pnpm --filter @brygadzista/server test:db   # Postgres + pgvector w dockerze na porcie 5433
pnpm test
pnpm typecheck
```

Inną bazę wskazujesz przez `TEST_DATABASE_URL` (testy czyszczą jej tabele).

## Docker / Openship

`Dockerfile` buduje jeden obraz (serwer + zbudowany dashboard; Node 22, poppler, użytkownik non-root). `deploy/openship.yaml` to compose dla projektu Openship na ruth154: `app` (port 3000, healthcheck `/api/health`, 768 MB) i `postgres` z pgvector (512 MB), wolumeny `app-data` (`/data`) i `postgres-data`.

```bash
ADMIN_TOKEN=... APP_TOKEN=... OPENROUTER_API_KEY=... docker compose -f deploy/openship.yaml up --build
```

Sekrety (`ADMIN_TOKEN`, `APP_TOKEN`, `OPENROUTER_API_KEY`, opcjonalnie `POSTGRES_PASSWORD`) ustawiamy w zmiennych środowiskowych Openship.
