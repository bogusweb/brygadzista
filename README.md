# Brygadzista

Asystent AI dla wykonawcy: agent, który zna projekt techniczny budynku (PDF) i odpowiada na pytania na budowie, z podaniem strony źródłowej. Docelowo także interaktywny model 3D domu w telefonie.

## Architektura

```
apps/server     Node 22 + Hono: API, upload i indeksowanie PDF, agent CopilotKit (AG-UI), serwuje dashboard
apps/dashboard  (epik) panel operatora: React + CopilotKit + A2UI
apps/mobile     (epik) aplikacja Expo: @copilotkit/react-native
deploy/         (epik) docker compose dla Openship na serwerze ruth154
```

**Indeksowanie PDF** (`apps/server/src/ingest.ts`): PDF jest strumieniowany na dysk, potem w tle strona po stronie: `pdftotext` (tekst), `pdftoppm` (JPEG strony), model z wizją robi ustrukturyzowany indeks strony (tytuł, rodzaj, opis, parametry, słowa kluczowe), a Gemini Embedding 2 liczy wektory (pgvector). Przetwarzanie jest wznawialne po restarcie.

**Wyszukiwanie** (`search.ts`): hybryda wektorowa (pgvector) + pełnotekstowa z prefiksami i trigramami (polska odmiana), łączona przez reciprocal rank fusion.

**Agent** (`agent.ts`): `BuiltInAgent` CopilotKit z narzędziami `search_project`, `list_pages`, `read_page`, `inspect_drawing`, `show_page`. Odpowiada po polsku i zawsze podaje źródło.

**Modele i prywatność**: wszystko przez OpenRouter, przypięte do jednego endpointu w UE, bez fallbacku, `data_collection: deny`, `zdr: true` (`llm.ts`).
- rozmowa: `anthropic/claude-opus-5.5` przez `google-vertex/europe`
- indeksowanie stron: `anthropic/claude-sonnet-5.5` przez `google-vertex/europe`
- embeddingi: `google/gemini-embedding-2` przez `google-vertex/eu`

## API (skrót)

| Metoda | Ścieżka | Rola |
| --- | --- | --- |
| GET | `/api/health` | publiczne |
| GET/POST | `/api/projects` | app/admin, admin |
| PUT | `/api/projects/:id/documents?filename=` (body = PDF) | admin |
| GET | `/api/projects/:id/documents` | app/admin |
| GET | `/api/documents/:id/pages` | app/admin |
| GET | `/api/documents/:id/pages/:n/image` (`?token=` dozwolony) | app/admin |
| POST | `/api/documents/:id/reindex` | admin |
| * | `/api/copilotkit/*` (nagłówek `x-project-id`) | app/admin |
| * | `/api/admin/copilotkit/*` (z A2UI) | admin |

Autoryzacja: `Authorization: Bearer <ADMIN_TOKEN|APP_TOKEN>`.

## Lokalnie

```bash
docker run -d -e POSTGRES_USER=brygadzista -e POSTGRES_PASSWORD=brygadzista -e POSTGRES_DB=brygadzista -p 5432:5432 pgvector/pgvector:pg16
pnpm install
cp apps/server/.env.example apps/server/.env   # uzupełnij OPENROUTER_API_KEY
cd apps/server && node --env-file=.env --import tsx src/index.ts
```

Wymaga `poppler-utils` (`pdfinfo`, `pdftotext`, `pdftoppm`).
