# Czas realizacji zadań – dashboard

Interaktywny wykres punktowy czasów realizacji zadań, publikowany przez GitHub Pages pod adresem
<https://forestinthejungle.github.io/pdf1126gs/>.

Strona jest statyczna (HTML + CSS + JavaScript bez zależności). Plik Excela jest wczytywany i parsowany
bezpośrednio w przeglądarce, więc nie ma kroku budowania.

## Metody liczenia percentyli

Zakładki nad filtrami przełączają metodę liczenia percentyli (wszystkie filtry są wspólne,
więc łatwo porównać wyniki na tej samej próbie):

- **Interpolacja liniowa** – identyczna z funkcją Excela `PERCENTILE.INC` (domyślna).
- **Nearest rank** – wartość zadania o randze `⌈p·n⌉` w posortowanej próbie; zawsze jest to czas konkretnego
  zadania. Bezpośredni link: <https://forestinthejungle.github.io/pdf1126gs/#nearest-rank>.

Trzecia zakładka, **Tempo dostarczania**, pokazuje przepustowość dzienną (opis niżej).

## Filtry (wspólne dla obu zakładek)

- **Pliki importu** – lista wszystkich plików `.xlsx` z repozytorium; można zaznaczyć jeden lub wiele (dane są łączone).
  Przycisk „Dodaj plik z dysku” wczytuje dodatkowy plik tylko w bieżącej karcie przeglądarki (nic nie jest wysyłane).
- **Okres** – suwak z dwoma uchwytami (początek i koniec okresu), pola dat „Od/Do” oraz szybkie przyciski 3, 6, 9… miesięcy
  i „Cały okres”.
- **Percentyle** – własne poziomy wpisywane ręcznie (0–100, np. `99,5`), do 8 naraz; domyślnie 50, 85 i 95. P85 jest wyróżniony.
- **Ręczne wykluczanie punktów** – kliknięcie punktu na wykresie (na ekranie dotykowym: drugie dotknięcie, na klawiaturze:
  Enter) wyklucza zadanie z próby; punkt zostaje na wykresie jako przekreślony i można go przywrócić kolejnym kliknięciem
  albo z listy „Wykluczone ręcznie” pod wykresem.
- **Odrzuć skrajne wartości** – przełącznik usuwa z wykresu i z obliczeń zadania spoza przedziału
  [Q1 − 1,5·IQR; Q3 + 1,5·IQR] bieżącej próby (reguła Tukeya, kwartyle liczone interpolacją liniową).

## Karty kontrolne Shewharta (XmR)

Pod wykresem punktowym (w obu zakładkach) są dwie zsynchronizowane karty: **X** (czas realizacji z naturalnymi
granicami procesu) oraz **mR** (rozstęp kroczący). Liczone są z tej samej próby co wykres punktowy, czyli po zastosowaniu
filtrów plików, rozmiaru, okresu, ręcznego wykluczenia punktów i (jeśli włączone) odrzucania wartości skrajnych.

- Zadania są ułożone rosnąco według daty ukończenia (i godziny, jeśli plik ją zawiera). Przy remisie zachowana jest
  kolejność z importu. Oś X to kolejny numer zadania.
- `MR[i] = |x[i] − x[i−1]|` (od drugiego zadania). Karta X: średnia ± 2,66 · średni mR. Karta mR: górna granica
  3,267 · średni mR, dolna 0.
- Punkty ściśle poza granicami są oznaczone jako „Sygnał do sprawdzenia”.
- Przybliżenie (przeciągnięcie myszą, przyciski albo klawisze + / − / 0) zmienia tylko widok, a granice pozostają
  liczone dla całej przefiltrowanej serii.
- Opcjonalna kolumna `ID` (także `ID zadania`, `Klucz`, `Nr`) jest pokazywana w dymkach.

## Zrozumienie zmienności (reguły Western Electric)

Na dole dashboardu (w obu zakładkach) są cztery wykresy ułożone jeden pod drugim. Wszystkie pokazują tę samą serię, średnią
i granice ±3σ co karta X, z tą samą kolejnością zadań i skalą osi Y. Krok σ = (górna granica − średnia) ÷ 3, więc ±3σ to
dokładnie granice karty X (liczone ze współczynnikiem 2,66), a linie ±1σ i ±2σ dzielą tę odległość na trzy równe części.
Wszystkie porównania są ścisłe i liczone na wartościach przed zaokrągleniem. Każda reguła działa niezależnie.

Na wykresach reguł 1–3 (oceniających odległość od średniej) trzy części odległości od średniej do granicy są zaznaczone po obu
stronach jako cieniowane strefy **1/3**, **2/3** i **3/3** (coraz ciemniejsze), z liniami ±1σ i ±2σ; linia, względem której
ocenia dana reguła, jest pogrubiona, a etykiety stref, w które muszą trafić jej punkty, są wyróżnione. Reguła 4 ocenia tylko
stronę średniej, więc jej wykres nie ma stref.

1. **Punkt poza granicami procesu** – punkt ściśle powyżej +3σ lub poniżej −3σ.
2. **Dwa z trzech poza 2σ** – w oknie 3 kolejnych zadań (przesuwanym o 1) co najmniej 2 ściśle poza ±2σ po tej samej stronie.
3. **Cztery z pięciu poza 1σ** – w oknie 5 kolejnych zadań co najmniej 4 ściśle poza ±1σ po tej samej stronie.
4. **Osiem po jednej stronie średniej** – nieprzerwana seria ≥ 8 punktów ściśle po jednej stronie (punkt równy średniej
   przerywa serię); cała seria to jedno zdarzenie, a ósmy punkt to moment wykrycia.

Przy tytule każdej reguły jest etykieta **Zachodzi** / **Nie zachodzi** dla bieżących filtrów. Zadania spełniające regułę
(punkt poza granicami, punkty ściśle za linią 2σ/1σ w pasujących oknach, wszystkie punkty serii) mają czerwoną obwódkę,
a pozostałe punkty są przygaszone. Pod wykresem jest ich lista (w przybliżeniu także liczba w bieżącym widoku). Gdy reguła nie
zachodzi, opis pokazuje, jak blisko była seria (najlepsze okno albo najdłuższa seria po jednej stronie średniej).

Gdy granic nie da się wyznaczyć (np. mniej niż 2 zadania albo granice równe średniej), wykresy pokazują
„Brak podstaw do wyznaczenia stref sygnału”; gdy seria jest krótsza niż 3, 5 lub 8 zadań – „Za mało zadań do oceny tej reguły”.
Przybliżenie wykresów zmienia tylko widok. Opcjonalne kolumny `Zmiana kontekstu` i `Komentarz` (także `Uwagi`) są pokazywane
w dymkach.

## Tempo dostarczania (przepustowość dzienna)

Zakładka **Tempo dostarczania** (bezpośredni link: <https://forestinthejungle.github.io/pdf1126gs/#tempo-dostarczania>)
pokazuje liczbę zadań dostarczonych każdego dnia z pliku przepustowości (np. `Throughput Daily.xlsx`). Punktem na
wykresach jest jeden dzień albo – po wybraniu agregacji **Tydzień (pon–pt)** – jeden tydzień od poniedziałku do piątku
(wartością jest suma zadań dostarczonych w dniach roboczych tego tygodnia; soboty i niedziele nigdy nie są liczone,
tygodnie bez dni roboczych są pomijane). Zakładka pokazuje tylko karty **X** i **mR** (bez wykresów reguł Western Electric).

- Karty są liczone z **median** (Wheeler): linia środkowa X to mediana wartości, granice X to
  mediana ± 3,145 · mediana mR, linia środkowa mR to mediana mR, a górna granica mR to 3,865 · mediana mR.
  Przepustowość nie może być ujemna, więc dolna granica X jest ustawiana na 0, gdy wyliczona wartość jest ujemna
  (wyliczona wartość jest pokazana w podsumowaniu), a oś Y zaczyna się od 0.
- Filtry tej zakładki: pliki przepustowości (przy kilku plikach wartości z tego samego dnia są sumowane), okres
  (pola „Od/Do” i szybkie przyciski 3, 6, 9… miesięcy), agregacja **Dzień / Tydzień (pon–pt)** oraz przełącznik
  **Pomiń weekendy i święta w Polsce** (domyślnie włączony), który przed wyznaczeniem granic usuwa z serii soboty,
  niedziele i ustawowe dni wolne w Polsce (1 i 6 stycznia, Wielkanoc i Poniedziałek Wielkanocny, 1 i 3 maja,
  Zielone Świątki, Boże Ciało, 15 sierpnia, 1 i 11 listopada, 24 grudnia od 2025 r., 25 i 26 grudnia).
- Plik przepustowości rozpoznawany jest po nagłówkach w pierwszym arkuszu: kolumna daty (`Data…`) i kolumna
  `Przepustowość` (także `Throughput`, `Dostarczone`). Taki plik nie trafia do zakładek czasu realizacji. Wiersze z błędną
  datą, ujemną lub nieliczbową wartością albo powtórzoną datą są pomijane i wymienione pod wykresami.

## Dodawanie i podmiana plików źródłowych

1. Dodaj plik `.xlsx` w dowolnym miejscu repozytorium (albo zastąp istniejący). Przy deployu skrypt
   `scripts/build-import-manifest.mjs` tworzy `import-files.json` z listą wszystkich plików `.xlsx`, a strona wczytuje je
   wszystkie. Bez tej listy (np. w podglądzie lokalnym) wczytywany jest plik z atrybutu `data-source` w `index.html`.
   Lokalnie listę można zbudować poleceniem `npm run manifest`.
2. Pliki przepustowości (patrz „Tempo dostarczania”) są wykrywane automatycznie. Pliki czasu realizacji muszą mieć dane w **pierwszym arkuszu**, z nagłówkami kolumn: `Data ukończenia`, `Deklarowany rozmiar (T-shirt)`,
   `Czas realizacji` (kolejność dowolna). Daty mogą być datami Excela albo tekstem, np. `15 Lipca 2024`.
   Rozmiary: `S`, `M`, `L`. Jeśli nagłówek czasu zawiera jednostkę, np. `Czas realizacji (dni)`, pojawi się ona na osi.
3. Zrób commit i push do gałęzi `main` – workflow `Deploy to GitHub Pages` opublikuje nową wersję.

Puste i błędne wiersze są pomijane, a ich liczba jest pokazana pod wykresem (osobno dla każdego pliku).

## Testy

```sh
npm test
```

Wymaga Node.js 18+ (bez instalowania pakietów).

Podgląd lokalny: `python3 -m http.server` w katalogu repozytorium, następnie <http://localhost:8000/>
(otwarcie `index.html` bezpośrednio z dysku nie zadziała, bo przeglądarka blokuje wczytanie pliku).
