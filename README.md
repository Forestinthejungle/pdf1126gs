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
- **Ręczne wykluczanie punktów** – kliknięcie punktu na wykresie (na ekranie dotykowym: drugie dotknięcie, na klawiaturze:
  Enter) wyklucza zadanie z próby; punkt zostaje na wykresie jako przekreślony i można go przywrócić kolejnym kliknięciem
  albo z listy „Wykluczone ręcznie” pod wykresem.
- **Odrzuć skrajne wartości** – przełącznik usuwa z wykresu i z obliczeń zadania spoza przedziału
  [Q1 − 1,5·IQR; Q3 + 1,5·IQR] bieżącej próby (reguła Tukeya, kwartyle liczone interpolacją liniową).

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
