# Czas realizacji zadań – dashboard

Interaktywny wykres punktowy czasów realizacji zadań, publikowany przez GitHub Pages pod adresem
<https://forestinthejungle.github.io/pdf1126gs/>.

Strona jest statyczna (HTML + CSS + JavaScript bez zależności). Plik Excela jest wczytywany i parsowany
bezpośrednio w przeglądarce, więc nie ma kroku budowania.

## Podmiana pliku źródłowego

1. Zastąp plik `Lead Times - 2024-25.xlsx` w katalogu głównym repozytorium nowym plikiem o **tej samej nazwie**
   (albo zmień nazwę w atrybucie `data-source` w `index.html`).
2. Dane muszą być w **pierwszym arkuszu**, z nagłówkami kolumn: `Data ukończenia`, `Deklarowany rozmiar (T-shirt)`,
   `Czas realizacji` (kolejność dowolna). Daty mogą być datami Excela albo tekstem, np. `15 Lipca 2024`.
   Rozmiary: `S`, `M`, `L`. Jeśli nagłówek czasu zawiera jednostkę, np. `Czas realizacji (dni)`, pojawi się ona na osi.
3. Zrób commit i push do gałęzi `main` – workflow `Deploy to GitHub Pages` opublikuje nową wersję.

Puste i błędne wiersze są pomijane, a ich liczba jest pokazana pod wykresem.

## Testy

```sh
npm test
```

Wymaga Node.js 18+ (bez instalowania pakietów).

Podgląd lokalny: `python3 -m http.server` w katalogu repozytorium, następnie <http://localhost:8000/>
(otwarcie `index.html` bezpośrednio z dysku nie zadziała, bo przeglądarka blokuje wczytanie pliku).
