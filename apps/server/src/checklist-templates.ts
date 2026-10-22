// Stage checklists for a single-family house (#68): what the crew checks before a stage is covered up or poured.
// Each item names what to read from the project (`ask`) and the words the project search starts from (`query`).
// The agent fills `ask` from the project with a quoted page; when the project says nothing, the item stays
// "do potwierdzenia" and the crew checks it with the designer or site manager.

export type ChecklistItemTemplate = { label: string; ask: string; query: string };

export type StageTemplate = { stage: string; title: string; when: string; items: ChecklistItemTemplate[] };

export const STAGE_TEMPLATES: StageTemplate[] = [
  {
    stage: "fundamenty",
    title: "Fundamenty",
    when: "Przed betonowaniem ław i ścian fundamentowych",
    items: [
      { label: "Wymiary ław fundamentowych", ask: "szerokość i wysokość ław fundamentowych", query: "ława fundamentowa szerokość wysokość wymiary" },
      { label: "Poziom posadowienia", ask: "rzędna lub głębokość posadowienia spodu ław", query: "poziom posadowienia rzędna spodu ławy głębokość" },
      { label: "Klasa betonu fundamentów", ask: "klasa betonu ław i ścian fundamentowych", query: "klasa betonu fundamenty ławy C20/25" },
      { label: "Zbrojenie ław", ask: "średnica i liczba prętów podłużnych oraz średnica i rozstaw strzemion w ławach", query: "zbrojenie ław pręty strzemiona średnica rozstaw" },
      { label: "Otulina zbrojenia", ask: "grubość otuliny zbrojenia w fundamentach", query: "otulina zbrojenia fundamenty" },
      { label: "Podbeton / chudy beton", ask: "grubość i klasa podbetonu pod ławami", query: "podbeton chudy beton pod ławy grubość" },
      { label: "Przepusty instalacyjne", ask: "przepusty w ławach i ścianach fundamentowych (woda, kanalizacja, prąd), średnice i położenie", query: "przepust fundament przyłącze kanalizacja woda rura osłonowa" },
      { label: "Izolacja przeciwwilgociowa", ask: "rodzaj izolacji przeciwwilgociowej/przeciwwodnej fundamentów", query: "izolacja przeciwwilgociowa fundamentów hydroizolacja" },
      { label: "Uziom fundamentowy", ask: "uziom fundamentowy: materiał, przekrój, wyprowadzenia", query: "uziom fundamentowy bednarka" },
    ],
  },
  {
    stage: "sciany",
    title: "Ściany",
    when: "W trakcie murowania ścian nośnych i działowych",
    items: [
      { label: "Materiał i grubość ścian zewnętrznych", ask: "materiał, klasa i grubość ścian zewnętrznych nośnych", query: "ściany zewnętrzne nośne materiał grubość bloczek pustak" },
      { label: "Ściany wewnętrzne nośne", ask: "materiał i grubość ścian wewnętrznych nośnych", query: "ściany wewnętrzne nośne grubość" },
      { label: "Zaprawa i spoiny", ask: "rodzaj zaprawy i grubość spoin", query: "zaprawa murarska klej spoina grubość" },
      { label: "Izolacja pozioma pod ścianami", ask: "izolacja pozioma pod pierwszą warstwą muru", query: "izolacja pozioma papa pierwsza warstwa muru" },
      { label: "Nadproża", ask: "typy nadproży, ich długość i oparcie nad otworami", query: "nadproże typ długość oparcie otwór" },
      { label: "Otwory okienne i drzwiowe", ask: "wymiary otworów w świetle muru i wysokość parapetów", query: "otwór okienny wymiary w świetle muru parapet wysokość" },
      { label: "Wysokość kondygnacji", ask: "wysokość ścian / kondygnacji w świetle i rzędne", query: "wysokość kondygnacji w świetle rzędna" },
      { label: "Kominy i kanały wentylacyjne", ask: "położenie i przekroje kanałów wentylacyjnych, spalinowych i dymowych", query: "komin kanał wentylacyjny spalinowy przekrój" },
    ],
  },
  {
    stage: "strop",
    title: "Strop i wieniec",
    when: "Przed zalaniem stropu i wieńca",
    items: [
      { label: "Grubość stropu", ask: "grubość płyty stropowej lub typ stropu", query: "strop grubość płyta stropowa typ" },
      { label: "Klasa betonu stropu i wieńca", ask: "klasa betonu stropu i wieńca", query: "klasa betonu strop wieniec" },
      { label: "Zbrojenie dolne stropu", ask: "średnica i rozstaw prętów zbrojenia dolnego stropu", query: "zbrojenie dolne strop pręty średnica rozstaw" },
      { label: "Zbrojenie górne nad podporami", ask: "średnica, rozstaw i długość prętów zbrojenia górnego nad podporami", query: "zbrojenie górne nad podporami strop pręty" },
      { label: "Otulina zbrojenia", ask: "grubość otuliny zbrojenia stropu", query: "otulina zbrojenia strop dystanse" },
      { label: "Wieniec", ask: "wymiary wieńca, pręty podłużne, strzemiona (średnica i rozstaw)", query: "wieniec zbrojenie strzemiona pręty wymiary" },
      { label: "Otwory i przepusty w stropie", ask: "otwory w stropie (schody, komin, piony instalacyjne) z wymiarami i zbrojeniem wymianów", query: "otwór w stropie przepust pion schody wymian" },
      { label: "Rzędna wierzchu stropu", ask: "rzędna wierzchu stropu", query: "rzędna stropu wierzch poziom" },
      { label: "Podparcie i rozszalowanie", ask: "wymagania dotyczące podparcia (stemplowania) i czasu rozszalowania", query: "stemple podparcie deskowanie rozszalowanie" },
    ],
  },
  {
    stage: "dach",
    title: "Dach",
    when: "Przed montażem pokrycia",
    items: [
      { label: "Konstrukcja więźby", ask: "typ więźby, przekroje krokwi, płatwi i murłaty, rozstaw krokwi", query: "więźba krokwie przekrój rozstaw płatew murłata" },
      { label: "Klasa drewna i impregnacja", ask: "klasa drewna konstrukcyjnego i rodzaj impregnacji", query: "drewno klasa C24 impregnacja więźba" },
      { label: "Kąt nachylenia dachu", ask: "kąt nachylenia połaci dachu", query: "kąt nachylenia dachu połać spadek" },
      { label: "Kotwienie murłaty", ask: "sposób kotwienia murłaty do wieńca (kotwy, średnica, rozstaw)", query: "kotwienie murłaty kotwy wieniec" },
      { label: "Membrana i łaty", ask: "membrana dachowa, kontrłaty i łaty (przekroje, rozstaw)", query: "membrana dachowa kontrłata łaty" },
      { label: "Pokrycie dachu", ask: "rodzaj pokrycia dachu", query: "pokrycie dachu dachówka blachodachówka" },
      { label: "Obróbki i odwodnienie", ask: "obróbki blacharskie, rynny i rury spustowe (średnice)", query: "rynny rury spustowe obróbki blacharskie średnica" },
      { label: "Ocieplenie dachu", ask: "materiał i grubość ocieplenia dachu lub stropu nad poddaszem", query: "ocieplenie dachu wełna grubość poddasze" },
    ],
  },
  {
    stage: "instalacje",
    title: "Instalacje przed zakryciem",
    when: "Przed zakryciem bruzd, tynkami i wylewkami",
    items: [
      { label: "Kanalizacja: piony i podejścia", ask: "średnice pionów i podejść kanalizacyjnych oraz spadki", query: "kanalizacja pion podejście średnica spadek" },
      { label: "Woda: rury i średnice", ask: "materiał i średnice rur instalacji wody zimnej i ciepłej", query: "instalacja wody rury średnica materiał ciepła zimna" },
      { label: "Ogrzewanie", ask: "rodzaj ogrzewania, rury (średnice), rozstaw pętli ogrzewania podłogowego", query: "ogrzewanie podłogowe pętle rozstaw rury średnica grzejniki" },
      { label: "Próba szczelności", ask: "wymagane ciśnienie i czas próby szczelności instalacji", query: "próba szczelności ciśnienie instalacja" },
      { label: "Elektryka: obwody i przekroje", ask: "przekroje przewodów i liczba obwodów", query: "instalacja elektryczna przewody przekrój obwody" },
      { label: "Wysokości gniazd i łączników", ask: "wysokości montażu gniazd i łączników", query: "gniazda łączniki wysokość montażu" },
      { label: "Wentylacja", ask: "kanały wentylacji (średnice, przebieg), rekuperacja", query: "wentylacja mechaniczna rekuperacja kanały średnica" },
      { label: "Przejścia przez przegrody", ask: "przejścia instalacji przez ściany i stropy (tuleje, uszczelnienia, przejścia ppoż.)", query: "przejście instalacji przez przegrody tuleja ochronna ppoż" },
    ],
  },
  {
    stage: "tynki",
    title: "Tynki",
    when: "Przed tynkowaniem",
    items: [
      { label: "Rodzaj tynku wewnętrznego", ask: "rodzaj tynku wewnętrznego (gipsowy, cementowo-wapienny) i kategoria", query: "tynk wewnętrzny gipsowy cementowo-wapienny kategoria" },
      { label: "Grubość tynku", ask: "grubość tynku", query: "tynk grubość" },
      { label: "Pomieszczenia mokre", ask: "tynk i hydroizolacja w łazienkach i pomieszczeniach mokrych", query: "łazienka pomieszczenia mokre tynk hydroizolacja" },
      { label: "Narożniki i siatki", ask: "narożniki ochronne, siatki na stykach materiałów", query: "narożnik siatka styk materiałów tynk" },
      { label: "Ościeża okien i drzwi", ask: "wykończenie ościeży okiennych i drzwiowych", query: "ościeża okna drzwi wykończenie" },
    ],
  },
  {
    stage: "wylewki",
    title: "Wylewki",
    when: "Przed wylaniem posadzek",
    items: [
      { label: "Warstwy podłogi", ask: "układ warstw podłogi na gruncie i na stropie z grubościami", query: "warstwy podłogi posadzka na gruncie grubość" },
      { label: "Grubość i rodzaj wylewki", ask: "grubość, rodzaj i klasa jastrychu/wylewki", query: "wylewka jastrych grubość klasa anhydryt cementowa" },
      { label: "Izolacja termiczna pod wylewką", ask: "materiał i grubość izolacji termicznej pod wylewką", query: "styropian podłoga izolacja termiczna grubość EPS" },
      { label: "Izolacja przeciwwilgociowa", ask: "izolacja przeciwwilgociowa podłogi na gruncie", query: "izolacja przeciwwilgociowa podłoga folia" },
      { label: "Dylatacje", ask: "dylatacje obwodowe i pola dylatacyjne (taśma, wielkość pól)", query: "dylatacja taśma dylatacyjna pole" },
      { label: "Rzędne posadzek", ask: "rzędne wykończonych posadzek", query: "rzędna posadzki poziom 0,00" },
      { label: "Spadki w pomieszczeniach mokrych", ask: "spadki posadzek do odpływów", query: "spadek posadzki odpływ liniowy" },
    ],
  },
  {
    stage: "szkielet",
    title: "Konstrukcja szkieletowa",
    when: "Przed zamknięciem ścian płytami",
    items: [
      { label: "Przekroje i klasa drewna", ask: "przekroje słupków, podwalin i oczepów oraz klasa wytrzymałości drewna (np. C24)", query: "słupki przekrój drewno C24 podwalina oczep" },
      { label: "Rozstaw słupków", ask: "rozstaw osiowy słupków w ścianach zewnętrznych i wewnętrznych", query: "rozstaw słupków osiowy 60 cm szkielet" },
      { label: "Kotwienie do fundamentu", ask: "sposób, rodzaj i rozstaw kotew podwaliny do płyty lub ściany fundamentowej", query: "kotwa podwalina kotwienie fundament rozstaw" },
      { label: "Poszycie i usztywnienie", ask: "rodzaj i grubość poszycia ścian (OSB, płyta MFP, gipsowo-włóknowa) i sposób usztywnienia", query: "poszycie OSB płyta usztywnienie ściany grubość" },
      { label: "Nadproża w ścianach szkieletowych", ask: "nadproża nad otworami: przekroje i oparcie", query: "nadproże szkielet otwór belka" },
      { label: "Izolacja termiczna ścian", ask: "materiał i grubość izolacji w ścianach (wełna między słupkami, docieplenie)", query: "wełna mineralna ściana szkieletowa grubość izolacja" },
      { label: "Paroizolacja", ask: "rodzaj paroizolacji lub membrany paroszczelnej i sposób klejenia połączeń", query: "paroizolacja folia paroszczelna membrana" },
      { label: "Wiatroizolacja", ask: "rodzaj wiatroizolacji / membrany wiatroizolacyjnej", query: "wiatroizolacja membrana wiatroizolacyjna" },
      { label: "Impregnacja drewna", ask: "wymagania dotyczące impregnacji drewna konstrukcyjnego", query: "impregnacja drewna konstrukcyjnego" },
    ],
  },
  {
    stage: "ocieplenie",
    title: "Ocieplenie ścian",
    when: "Przed klejeniem płyt i przed tynkiem cienkowarstwowym",
    items: [
      { label: "Materiał i grubość ocieplenia", ask: "materiał izolacji ścian zewnętrznych, grubość i współczynnik lambda", query: "ocieplenie ścian styropian wełna grubość lambda" },
      { label: "Ocieplenie cokołu", ask: "materiał, grubość i wysokość ocieplenia cokołu", query: "cokół ocieplenie XPS grubość wysokość" },
      { label: "Klejenie płyt", ask: "sposób klejenia płyt (metoda obwodowo-punktowa, powierzchnia kleju)", query: "klej do styropianu metoda obwodowo-punktowa klejenie płyt" },
      { label: "Łączniki mechaniczne", ask: "rodzaj, liczba na m² i długość łączników mechanicznych (kołków)", query: "łączniki mechaniczne kołki liczba na m2 kotwienie" },
      { label: "Ocieplenie ościeży", ask: "grubość ocieplenia ościeży okiennych i drzwiowych", query: "ościeża ocieplenie grubość" },
      { label: "Warstwa zbrojona", ask: "siatka zbrojąca (gramatura), zaprawa i wzmocnienia narożników", query: "siatka zbrojąca gramatura warstwa zbrojona narożniki" },
      { label: "Tynk zewnętrzny", ask: "rodzaj, faktura i kolor tynku zewnętrznego", query: "tynk silikonowy cienkowarstwowy faktura kolor" },
      { label: "Bariera ogniowa", ask: "pasy przeciwogniowe z wełny (gdzie i jakiej szerokości), jeśli wymagane", query: "pas przeciwogniowy wełna bariera ogniowa" },
    ],
  },
  {
    stage: "stolarka",
    title: "Okna i drzwi zewnętrzne",
    when: "Przed montażem stolarki",
    items: [
      { label: "Wymiary i oznaczenia okien", ask: "zestawienie okien: oznaczenia, wymiary, podziały i kierunek otwierania", query: "zestawienie stolarki okna wymiary oznaczenie" },
      { label: "Współczynnik U okien", ask: "wymagany współczynnik przenikania ciepła okien i drzwi (Uw, Ud)", query: "współczynnik przenikania ciepła okna Uw drzwi" },
      { label: "Montaż (ciepły montaż)", ask: "sposób montażu stolarki: warstwa ocieplenia, taśmy paroszczelne i paroprzepuszczalne", query: "ciepły montaż taśmy paroszczelne okna montaż" },
      { label: "Położenie okna w murze", ask: "położenie okna w grubości ściany (w warstwie ocieplenia, w licu muru)", query: "okno w warstwie ocieplenia położenie w murze" },
      { label: "Parapety", ask: "rodzaj parapetów zewnętrznych i wewnętrznych oraz wysięg", query: "parapet zewnętrzny wewnętrzny" },
      { label: "Drzwi zewnętrzne", ask: "drzwi zewnętrzne: wymiary, klasa, próg", query: "drzwi zewnętrzne wejściowe wymiary" },
      { label: "Nawiewniki", ask: "nawiewniki okienne lub ścienne: gdzie i jakie", query: "nawiewnik okienny wentylacja" },
    ],
  },
];

export const stageTemplate = (stage: string) => STAGE_TEMPLATES.find((template) => template.stage === stage);
