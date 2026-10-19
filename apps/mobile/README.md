# apps/mobile

Aplikacja Expo (SDK 58, expo-router) dla wykonawcy. Na razie: konfiguracja połączenia z serwerem, lista projektów i ekran projektu z podłączonym `CopilotKitProvider`. Czat i podgląd stron dochodzą w kolejnych zadaniach epiku #4.

## Uruchomienie

```bash
pnpm install              # w katalogu głównym repo
cd apps/mobile
pnpm start                # zeskanuj kod QR w Expo Go
```

Przy pierwszym starcie aplikacja pyta o adres serwera (np. `https://brygadzista.example.pl`) i kod dostępu (`APP_TOKEN` z serwera). Oba są zapisywane w `expo-secure-store`; zapis następuje dopiero, gdy `GET /api/projects` z tymi danymi się powiedzie.

Podgląd w przeglądarce (`pnpm web`) służy tylko do szybkiego sprawdzenia ekranów: na webie dane zapisują się w `localStorage`.

## Struktura

```
src/app/_layout.tsx        polyfille CopilotKit, gesty, nawigacja (Stack)
src/app/index.tsx          lista projektów (GET /api/projects), przekierowanie do ustawień
src/app/settings.tsx       adres serwera + kod dostępu
src/app/projects/[id].tsx  ekran projektu w CopilotKitProvider (nagłówki Authorization i x-project-id)
src/lib/                   ustawienia, klient API, motyw
src/components/            przycisk, provider CopilotKit, status połączenia z agentem
```

## CopilotKit a Expo Go

Aplikacja importuje `@copilotkit/react-native/headless`, czyli provider i hooki bez gotowych komponentów czatu. Komponenty `CopilotChat`/`CopilotModal` korzystają z `react-native-streamdown`, który wymaga natywnego `react-native-enriched-markdown`, a tego modułu nie ma w Expo Go. Zależności są zainstalowane, ale użycie tych komponentów oznacza development build (`npx expo run:android` albo EAS). Alternatywa, która dalej działa w Expo Go: własny czat na `useAgent`.
