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

## Filtry (wspólne dla obu zakładek)

- **Pliki importu** – lista wszystkich plików `.xlsx` z repozytorium; można zaznaczyć jeden lub wiele (dane są łączone).
  Przycisk „Dodaj plik z dysku” wczytuje dodatkowy plik tylko w bieżącej karcie przeglądarki (nic nie jest wysyłane).
- **Okres** – suwak z dwoma uchwytami (początek i koniec okresu), pola dat „Od/Do” oraz szybkie przyciski 3, 6, 9… miesięcy
  i „Cały okres”.
- **Percentyle** – własne poziomy wpisywane ręcznie (0–100, np. `99,5`), do 8 naraz; domyślnie 50, 85 i 95. P85 jest wyróżniony.
- **Odrzuć skrajne wartości** – przełącznik usuwa z wykresu i z obliczeń zadania spoza przedziału
  [Q1 − 1,5·IQR; Q3 + 1,5·IQR] bieżącej próby (reguła Tukeya, kwartyle liczone interpolacją liniową).

## Karty kontrolne Shewharta (XmR)

Pod wykresem punktowym (w obu zakładkach) są dwie zsynchronizowane karty: **X** (czas realizacji z naturalnymi
granicami procesu) oraz **mR** (rozstęp kroczący). Liczone są z tej samej próby co wykres punktowy, czyli po zastosowaniu
filtrów plików, rozmiaru, okresu i (jeśli włączone) odrzucania wartości skrajnych.

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

1. **Punkt poza granicami procesu** – punkt ściśle powyżej +3σ lub poniżej −3σ.
2. **Dwa z trzech poza 2σ** – w oknie 3 kolejnych zadań (przesuwanym o 1) co najmniej 2 ściśle poza ±2σ po tej samej stronie.
3. **Cztery z pięciu poza 1σ** – w oknie 5 kolejnych zadań co najmniej 4 ściśle poza ±1σ po tej samej stronie.
4. **Osiem po jednej stronie średniej** – nieprzerwana seria ≥ 8 punktów ściśle po jednej stronie (punkt równy średniej
   przerywa serię); cała seria to jedno zdarzenie, a ósmy punkt to moment wykrycia.

Gdy granic nie da się wyznaczyć (np. mniej niż 2 zadania albo granice równe średniej), wykresy pokazują
„Brak podstaw do wyznaczenia stref sygnału”; gdy seria jest krótsza niż 3, 5 lub 8 zadań – „Za mało zadań do oceny tej reguły”.
Przybliżenie wykresów zmienia tylko widok. Opcjonalne kolumny `Zmiana kontekstu` i `Komentarz` (także `Uwagi`) są pokazywane
w dymkach.

## Dodawanie i podmiana plików źródłowych

1. Dodaj plik `.xlsx` w dowolnym miejscu repozytorium (albo zastąp istniejący). Przy deployu skrypt
   `scripts/build-import-manifest.mjs` tworzy `import-files.json` z listą wszystkich plików `.xlsx`, a strona wczytuje je
   wszystkie. Bez tej listy (np. w podglądzie lokalnym) wczytywany jest plik z atrybutu `data-source` w `index.html`.
   Lokalnie listę można zbudować poleceniem `npm run manifest`.
2. Dane muszą być w **pierwszym arkuszu**, z nagłówkami kolumn: `Data ukończenia`, `Deklarowany rozmiar (T-shirt)`,
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
