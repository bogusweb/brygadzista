# Brygadzista

Asystent AI dla wykonawcy: agent, który zna projekt techniczny budynku (PDF) i odpowiada na pytania na budowie, z podaniem strony źródłowej. Docelowo także interaktywny model 3D domu w telefonie.

## Architektura

```
apps/server     Node 22 + Hono: API, upload i indeksowanie PDF, agent CopilotKit (AG-UI), serwuje dashboard
apps/dashboard  panel operatora: Vite + React 19, czat CopilotKit z A2UI, upload PDF
apps/mobile     aplikacja Expo (expo-router, @copilotkit/react-native), zob. apps/mobile/README.md
openship.yaml   docker compose dla Openship na serwerze ruth154 (kontekst budowania to katalog główny repo)
```

**Indeksowanie PDF** (`apps/server/src/ingest.ts`): PDF jest strumieniowany na dysk, potem w tle strona po stronie: `pdftotext` (tekst), `pdftoppm` (JPEG strony), a Gemini Embedding 2 liczy wektory fragmentów tekstu i obrazu całej strony w jednej przestrzeni (pgvector), więc rysunek bez warstwy tekstowej też da się znaleźć. Indeksowanie nie używa modelu językowego; tytuł strony to pierwsza linia jej tekstu. Przetwarzanie jest wznawialne: każda strona ma swój stan (`indexed`, `error`, `attempts`), po restarcie dokument wraca do kolejki i pomija gotowe strony. Brak środków lub limit budżetu klucza OpenRouter (402) albo limit zapytań po wszystkich ponowieniach (429) wstrzymuje dokument (status `paused` z komunikatem) zamiast oznaczać go jako błędny; przycisk „Wznów indeksowanie” w dashboardzie (`POST /api/documents/:id/resume`) bierze tylko strony niegotowe, a „Indeksuj ponownie” (`reindex`) liczy wszystko od nowa.

**Duże PDF-y** (setki stron, arkusze A0/A1):
- Upload jest strumieniowany i przerywany po przekroczeniu `MAX_UPLOAD_MB` (413); PDF z więcej niż `MAX_PAGES` stron jest odrzucany.
- Odpowiedź uploadu zawiera `pageCount` i `estimate` (`costUsd`, `seconds`), liczone z `INDEX_COST_PER_PAGE_USD`, `INDEX_SECONDS_PER_PAGE` i `INDEX_CONCURRENCY`. Z `?autostart=0` dokument ma status `awaiting_start` i czeka na `POST /api/documents/:id/start` z dashboardu.
- W trakcie indeksowania `GET /api/documents/:id` (i lista dokumentów) zwraca `progress` (`total`, `done`, `etaSeconds` liczone z dotychczasowego tempa) oraz `failedPages`.
- Każde wywołanie modelu ma timeout (`LLM_TIMEOUT_MS`) i ponowienia z wykładniczym backoffem i jitterem przy 408/429/5xx, timeoutach i zerwanych połączeniach (z respektowaniem `Retry-After`). Wywołania poppler też mają timeout.
- Strona, która mimo ponowień się nie udała, jest zapisywana z błędem i pomijana, a reszta dokumentu idzie dalej (status `ready`, w `error` lista stron do ponowienia). Dopiero `MAX_CONSECUTIVE_PAGE_FAILURES` błędów pod rząd (np. zły klucz, awaria) zatrzymuje dokument.
- `inspect_drawing` na arkuszu większym niż A3 dostaje podgląd całej strony i do 9 nachodzących na siebie kafelków w rozdzielczości do 150 DPI (`drawing.ts`), żeby drobne wymiary były czytelne. Każdy JPEG ma najwyżej 2,5 MB (w razie potrzeby niższa jakość). Kafelki renderują się przy pierwszym użyciu i są cache'owane na dysku.

**Wyszukiwanie** (`search.ts`): hybryda wektorowa (pgvector) + pełnotekstowa z prefiksami i trigramami (polska odmiana) + dokładne kody (`codes.ts`: oznaczenia rysunków i detali, klasy, profile, Ø, wartości z jednostkami, normy, np. „A-04”, „RAL 9006”, „λD= 0,035”, zapisane jednym sposobem w `pages.codes`), łączona przez reciprocal rank fusion. Skróty branżowe (MW, XPS, EPS, BSO, żb…) są w zapytaniu rozwijane do pełnych nazw. Wynik dostaje tylko strona, która przechodzi choć jeden próg trafności: wspólny kod, co najmniej połowa słów treści pytania (bez „jaki”, „ile”, „gdzie”…) albo odległość wektora ≤ `SEARCH_MAX_DISTANCE` (domyślnie 0,5, do strojenia evalem); gdy nic nie przechodzi, `search_project` zwraca `noMatch`. Fragment w wyniku to okno tekstu strony wokół słów i kodów z pytania.

**Agent** (`agent.ts`): `BuiltInAgent` CopilotKit z narzędziami `search_project`, `list_pages`, `read_page`, `inspect_drawing`, `show_page`. Odpowiada po polsku i zawsze podaje źródło.

**Zdjęcia na rzucie** (#70, `pins.ts`): pinezka to punkt na stronie projektu we współrzędnych względnych strony (0..1) z pomieszczeniem, notatką i zdjęciami. Identyfikatory pinezek i zdjęć generuje telefon, więc ponowiona po zerwaniu synchronizacja niczego nie dubluje; przy edycji wygrywa nowszy `updatedAt`. Zdjęcie (JPEG/PNG/WebP, do `MAX_PHOTO_MB`, domyślnie 25 MB) serwer obraca wg EXIF, usuwa metadane (także GPS), zmniejsza do `PHOTO_MAX_EDGE` px (domyślnie 2560) i robi miniaturę 480 px (sharp). Pliki leżą w `DATA_DIR/projects/<projekt>/photos/`, więc kopia wolumenu `/data` (#13) obejmuje je razem z PDF-ami. Agent ma narzędzie `search_photos` (słowa z notatki, pomieszczenia i tytułu strony z polską odmianą, strona, zakres dat). Pole `kind` (na razie `photo`) zostawia miejsce na usterki (#74).

**Katalog A2UI** (`apps/server/src/a2ui-catalog.ts`): komponenty budowlane, które agent może pokazać przez `render_a2ui` obok podstawowego katalogu A2UI: `ParameterCard` (parametr z jednostką i źródłem), `MaterialList` (materiały z ilościami), `WorkSteps` (kroki prac), `LayerComparison` (warstwy przegród obok siebie). Definicje (zod v3, opisy dla modelu) są wspólne: serwer wysyła z nich schemat v0.9 w `a2ui.schema` runtime'u (`a2ui-schema.ts`), a dashboard renderuje je w `apps/dashboard/src/a2uiCatalog.tsx`, a aplikacja mobilna własnym natywnym rendererem (`apps/mobile/src/components/a2ui/`). Oba runtime'y (`/api/copilotkit` i `/api/admin/copilotkit`) mają A2UI. Linki „str. N” w komponentach otwierają stronę projektu.

**Checklisty etapów** (`checklist-templates.ts`, `checklists.ts`, #68): szablony dla domu jednorodzinnego (fundamenty, ściany, strop i wieniec, dach, instalacje przed zakryciem, tynki, wylewki). Po `POST /api/projects/:id/checklists` (`{stage}`) serwer w tle wypełnia każdą pozycję: wyszukiwanie w projekcie, potem model czyta wartość ze znalezionych stron. Pozycja ma status `found` tylko wtedy, gdy cytat naprawdę jest na wskazanej stronie; inaczej `to_confirm` („do potwierdzenia”) z odnośnikiem do strony, gdzie temat się pojawia (albo bez źródła). Bez klucza OpenRouter wszystko jest `to_confirm` z najlepszą stroną. Odhaczanie idzie przez `POST /api/checklists/:id/sync` z paczką zdarzeń (`check` z `itemId`, `checked`, `note` albo `complete`), każde z własnym `id` (UUID z aplikacji) i czasem `at`: ponownie wysłana paczka nie zmienia nic drugi raz, a o stanie pozycji decyduje najpóźniejsza zmiana wg czasu jej zrobienia, więc aplikacja może je zbierać offline i wysłać po powrocie zasięgu. `complete` zapisuje wynik z datą, osobą i stanem wszystkich pozycji.

**Modele i prywatność**: wszystko przez OpenRouter z `data_collection: deny` i `zdr: true` (`llm.ts`). Modele językowe są przypięte do jednego endpointu w UE, bez fallbacku. Embeddingi mogą iść poza UE.
- rozmowa: `google/gemini-3.1-flash-lite` przez `google-vertex/eu`
- oglądanie rysunku na żądanie agenta (`inspect_drawing`): ten sam model (`VISION_MODEL`)
- embeddingi tekstu i obrazów stron: `google/gemini-embedding-2`, dowolny dostawca z `zdr: true` i `data_collection: deny` (mogą być poza UE; `EMBEDDING_PROVIDER` przypina jednego), 1536 wymiarów; zmiana modelu wymaga ponownego indeksowania

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
| GET | `/api/projects/:id/search-index` (tekst wszystkich stron projektu do wyszukiwania offline w aplikacji) | app/admin |
| GET/POST | `/api/projects/:id/diary` (dziennik dnia, #69; POST: body `audio/*` z `?date=&clientId=` albo JSON `{text, date, clientId}`) | app/admin |
| PATCH/DELETE | `/api/diary/:id` (`{entryDate?, transcript?, entry?}`), POST `/api/diary/:id/retry` | app/admin |
| GET | `/api/documents/:id/pages/:n/image` (przyjmuje też `?token=`) | app/admin |
| GET | `/api/projects/:id/pins` (pinezki projektu ze zdjęciami) | app/admin |
| PUT/DELETE | `/api/projects/:id/pins/:pinId` (`{documentId, pageNo, x, y, note, room, createdAt, updatedAt}`) | app/admin |
| PUT | `/api/projects/:id/pins/:pinId/photos/:photoId?takenAt=` (body = zdjęcie) | app/admin |
| DELETE | `/api/projects/:id/photos/:photoId` | app/admin |
| GET | `/api/projects/:id/photos/:photoId/image?size=thumb` (przyjmuje też `?token=`) | app/admin |
| POST | `/api/documents/:id/resume` (tylko niegotowe strony; dokument `paused`, `error` lub `ready`) | admin |
| POST | `/api/documents/:id/reindex` | admin |
| GET | `/api/checklist-templates` | app/admin |
| GET/POST | `/api/projects/:id/checklists` (`{stage}` → 202, wypełnianie w tle) | app/admin |
| GET | `/api/checklists/:id` (pozycje, źródła, wyniki) | app/admin |
| POST | `/api/checklists/:id/sync` (`{events}` zebrane offline) | app/admin |
| DELETE | `/api/checklists/:id` | admin |
| * | `/api/copilotkit/*` (nagłówek `x-project-id`) | app/admin |
| * | `/api/admin/copilotkit/*` (z A2UI) | admin |

Autoryzacja: `Authorization: Bearer <token>`.

**Konta** (#10): właściciel (`owner`, rola API `admin`) widzi wszystkie projekty i zarządza kontami; wykonawca (`contractor`, rola API `app`) widzi tylko projekty, do których go dodano (lista projektów, dokumenty, strony, obrazy stron i fabryka agenta; cudzy projekt odpowiada 404). Hasła to argon2id, sesja to losowy token `bs_…` (w bazie tylko jego SHA-256), ważny `SESSION_TTL_DAYS` dni i przedłużany przy użyciu. Wyłączenie konta lub nowe hasło kończy jego sesje.
- `ADMIN_TOKEN` z env działa dalej jako awaryjny dostęp administratora; nim zakłada się pierwsze konto właściciela (`POST /api/users` z `role: "owner"`).
- `APP_TOKEN` to stary wspólny token aplikacji (wszystkie projekty). Jest wyłączony, gdy pusty, a w produkcji (`NODE_ENV=production`) także gdy nieustawiony.
- Limity (w pamięci procesu): uruchomienia agenta `RATE_LIMIT_CHAT_PER_MINUTE` na użytkownika, upload `RATE_LIMIT_UPLOADS_PER_HOUR`, notatki do dziennika `RATE_LIMIT_DIARY_PER_HOUR`, logowanie `RATE_LIMIT_LOGIN_PER_15_MIN` na e-mail (i 5× tyle na IP). Po przekroczeniu 429 z `Retry-After`.

**Dziennik dnia** (#69): nagranie (m4a z telefonu, mp4 lub ogg z przeglądarki, do `MAX_DIARY_AUDIO_MB`) jest zapisywane w `DATA_DIR/diary` i porządkowane w tle: transkrypcja i wpis (prace, ludzie, dostawy, pogoda, problemy, odniesienia do stron projektu) robi model czatu (`AGENT_MODEL`, region EU, bez retencji). Strony do odniesień szuka wyszukiwanie słowne i kodów, bez embeddingów. Nieudany wpis zostaje z nagraniem, `retry` porządkuje go ponownie; wpis przerwany restartem serwer bierze po starcie. `clientId` z kolejki offline sprawia, że powtórzone wysłanie nie tworzy drugiego wpisu. Z `FAKE_AGENT=1` transkrypcja i wpis są skryptowane.

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

Testy (`apps/server/test`, vitest) działają na prawdziwym Postgresie z pgvector, a embeddingi są zamockowane, więc nie potrzebują klucza OpenRouter. Nie ma CI w GitHub Actions: testy uruchamiamy lokalnie i wklejamy wynik do PR.

```bash
pnpm --filter @brygadzista/server test:db   # Postgres + pgvector w dockerze na porcie 5433
pnpm test
pnpm typecheck
```

Inną bazę wskazujesz przez `TEST_DATABASE_URL` (testy czyszczą jej tabele).

### Trafność wyszukiwania

`apps/server/eval/hala-pilawa.json` to 55 pytań o próbny PDF z oczekiwanymi stronami (wymiary, oznaczenia, skróty, materiały, pytania ogólne i takie, na które projekt nie odpowiada). Skrypt liczy recall@1/3/6 i MRR dla rankingu tekstowego, wektorowego i hybrydy oraz to, jak często wyszukiwanie słusznie nic nie zwraca:

```bash
# indeksuje PDF do projektu „eval: …” w bazie z DATABASE_URL (ponowne uruchomienie go nie indeksuje), potem liczy wynik
pnpm --filter @brygadzista/server eval -- --pdf ścieżka/do/projektu.pdf --verbose
# albo projekt już zaindeksowany
pnpm --filter @brygadzista/server eval -- --project <id projektu>
```

Bez `OPENROUTER_API_KEY` działa tylko ranking tekstowy (za darmo); z kluczem dochodzą embeddingi zapytań, ok. $0,01 za przebieg.

## Docker / Openship

`Dockerfile` buduje jeden obraz (serwer + zbudowany dashboard; Node 22, poppler, użytkownik non-root). `openship.yaml` (w katalogu głównym, bo Openship nie przyjmuje kontekstu budowania poza katalogiem pliku compose) to compose dla projektu Openship na ruth154: `app` (port 3000, healthcheck `/api/health`, 768 MB) i `postgres` z pgvector (512 MB), wolumeny `app-data` (`/data`) i `postgres-data`.

```bash
ADMIN_TOKEN=... APP_TOKEN=... OPENROUTER_API_KEY=... docker compose -f openship.yaml up --build
```

Sekrety (`ADMIN_TOKEN`, `APP_TOKEN`, `OPENROUTER_API_KEY`, opcjonalnie `POSTGRES_PASSWORD`) ustawiamy w zmiennych środowiskowych Openship.
