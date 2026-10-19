# apps/mobile

Aplikacja Expo (SDK 58, expo-router) dla wykonawcy: konfiguracja połączenia z serwerem, lista projektów i czat z asystentem, który zna projekt. Asystent pokazuje rysunki (`show_page`) z powiększaniem palcami, a źródła „str. N” w odpowiedziach otwierają stronę.

## Uruchomienie

```bash
pnpm install              # w katalogu głównym repo
cd apps/mobile
pnpm start                # zeskanuj kod QR w Expo Go
```

Przy pierwszym starcie aplikacja pyta o adres serwera (np. `https://brygadzista.example.pl`) i kod dostępu (`APP_TOKEN` z serwera). Oba są zapisywane w `expo-secure-store`; zapis następuje dopiero, gdy `GET /api/projects` z tymi danymi się powiedzie.

Podgląd w przeglądarce (`pnpm web`) służy tylko do szybkiego sprawdzenia ekranów: na webie dane zapisują się w `localStorage`.

## Test bez klucza OpenRouter

Serwer testowy udaje backend: prawdziwy runtime CopilotKit i pętla narzędzi, tylko model i dane są zaskryptowane (wyszukanie, `show_page` ze str. 12, odpowiedź ze źródłami).

```bash
pnpm --filter @brygadzista/server mock    # http://localhost:3100, kod dostępu: demo
```

W aplikacji podaj adres komputera w sieci lokalnej (np. `http://192.168.1.20:3100`; telefon musi być w tej samej sieci). Pytanie ze słowem „awaria” za pierwszym razem kończy się błędem, żeby sprawdzić komunikat i przycisk „Ponów”.

Testy logiki czatu: `pnpm test` (vitest).

## Struktura

```
src/app/_layout.tsx        polyfille CopilotKit, gesty, nawigacja (Stack)
src/app/index.tsx          lista projektów (GET /api/projects), przekierowanie do ustawień
src/app/settings.tsx       adres serwera + kod dostępu
src/app/projects/[id].tsx  ekran projektu: CopilotKitProvider (nagłówki Authorization i x-project-id) + czat
src/lib/                   ustawienia, klient API, motyw, logika czatu (chat.ts + testy)
src/components/            przycisk, provider CopilotKit, status połączenia z agentem
src/components/chat/       czat na useAgent, statusy narzędzi, karta show_page, pełny ekran z pinch-zoom
```

## CopilotKit a Expo Go

Aplikacja importuje `@copilotkit/react-native/headless`, czyli provider i hooki bez gotowych komponentów czatu. Komponenty `CopilotChat`/`CopilotModal` korzystają z `react-native-streamdown`, który wymaga natywnego `react-native-enriched-markdown`, a tego modułu nie ma w Expo Go. Dlatego czat jest własny, na `useAgent` i `useRenderTool`, z prostym formatowaniem odpowiedzi (akapity, listy, pogrubienie, linki do stron). Działa w Expo Go. Powiększanie rysunków używa `react-native-gesture-handler` i `react-native-reanimated`, które Expo Go ma wbudowane.

Gdyby kiedyś potrzebny był gotowy `CopilotChat` (pełny Markdown, załączniki), trzeba przejść na development build (`npx expo run:android` albo EAS).
