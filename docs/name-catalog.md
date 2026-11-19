# Name catalog

`data/reference-catalog.json` lists the first names Bébé Bonjour recognises. A recognised name gives the R1 composer its sourced meaning (`nameReference`) and, for a Muslim family, the Quranic verses where the word itself appears. Any other name still works: the composer then speaks of what the parents put into the name and claims no etymology.

## Which names

- The most given names in France in 2025, girls and boys, from the INSEE national first-names file ([Fichier des prénoms, édition 2026](https://www.insee.fr/fr/statistiques/8595130), `prenoms-2025-nat.csv`, 2025 period).
- Common Arabic and Muslim names, kept when they also appear in that INSEE file (every entry below has a 2025 rank).
- A name is left out when its meaning is uncertain or contested on the source (Arthur, Jules, Camille, Léa, Alma, Maryam, Fatima, Zaynab…), or when the same Latin spelling maps to different Arabic names (Malik: ملك or مالك; Amina and Amna collapse to one Arabic form). The operator covers those case by case.

## Entry format

Each entry has `canonical` (Latin, and Arabic for Arabic names), `aliases` (spellings families actually use; accents count, so `Ilyes` and `Ilyès` are listed separately), `gender`, `origin` (key of `origins`, with its French and Arabic label), `sources` and the suggestions read by `scripts/lib/name-resolution.mjs`:

- `general[0]` and, when the name appears in the Quran, `religious.islam[0]`: `meaning.fr`, `meaning.ar`, `meaningSourceKeys` and `verses`.
- `sources` maps each key to its URL. Meanings come from [Behind the Name](https://www.behindthename.com); when the name's own page only says "French form of Ludwig", both pages are cited.
- A meaning without `meaningSourceKeys` is not claimed (Bayane: Behind the Name only lists it among user-submitted names).
- Meaning text never contains the name or its aliases (Amal → الرجاء, not الأمل): the composer rejects any meaning line that spells the name before the reveal.

## Verses

`data/quran-verses.json` holds the full text of every cited verse: Arabic from the [Tanzil](https://tanzil.net/download/) Simple text (verbatim, CC BY 3.0 notice included in the file) and French from Muhammad Hamidullah's translation (quran.com translation 31, footnote markers removed). Catalog quotes are exact excerpts of those texts, and a verse is cited only when the name's word appears in it. Never paraphrase or generate a verse.

`test/reference-catalog.test.mjs` checks that every entry has a source, every verse quote and reference matches `data/quran-verses.json`, canonical forms and aliases are unique, each name resolves to itself, and no meaning spells its name.

## Adding a name

1. Find it in the INSEE national file and on Behind the Name. Skip it if the meaning is marked uncertain.
2. Add the entry with its sources, aliases and a meaning in both languages that avoids the name itself.
3. For a verse, copy the Arabic from Tanzil and the French from Hamidullah into `data/quran-verses.json`, then quote an excerpt in the entry.
4. Run `node --test test/reference-catalog.test.mjs`.

## Names (INSEE 2025 rank; best rank among the listed spellings)

| Name | Arabic | | INSEE 2025 rank | Verses | Meaning source |
| --- | --- | --- | --- | --- | --- |
| Gabriel |  | boy | 1 |  | [gabriel](https://www.behindthename.com/name/gabriel) |
| Noah | نوح | boy | 2 | 1 | [noah-1](https://www.behindthename.com/name/noah-1) |
| Léo |  | boy | 3 |  | [leo](https://www.behindthename.com/name/leo) |
| Raphaël |  | boy | 4 |  | [raphael](https://www.behindthename.com/name/raphael) |
| Louis |  | boy | 5 |  | [louis](https://www.behindthename.com/name/louis), [ludwig](https://www.behindthename.com/name/ludwig) |
| Léon |  | boy | 8 |  | [leon](https://www.behindthename.com/name/leon) |
| Adam | آدم | boy | 9 | 1 | [adam](https://www.behindthename.com/name/adam) |
| Maël |  | boy | 10 |  | [mael](https://www.behindthename.com/name/mael), [mae12l](https://www.behindthename.com/name/mae12l) |
| Isaac | إسحاق | boy | 11 | 1 | [isaac](https://www.behindthename.com/name/isaac) |
| Sacha |  | boy | 12 |  | [sacha](https://www.behindthename.com/name/sacha), [alexander](https://www.behindthename.com/name/alexander) |
| Liam |  | boy | 14 |  | [liam](https://www.behindthename.com/name/liam), [william](https://www.behindthename.com/name/william) |
| Mohamed | محمد | boy | 21 | 1 | [muhammad](https://www.behindthename.com/name/muhammad) |
| Malo |  | boy | 22 |  | [malo](https://www.behindthename.com/name/malo) |
| Paul |  | boy | 23 |  | [paul](https://www.behindthename.com/name/paul) |
| Hugo |  | boy | 25 |  | [hugo](https://www.behindthename.com/name/hugo), [hugh](https://www.behindthename.com/name/hugh) |
| Ibrahim | إبراهيم | boy | 26 | 1 | [ibrahim](https://www.behindthename.com/name/ibrahim), [abraham](https://www.behindthename.com/name/abraham) |
| Victor |  | boy | 28 |  | [victor](https://www.behindthename.com/name/victor) |
| Ethan |  | boy | 30 |  | [ethan](https://www.behindthename.com/name/ethan) |
| Imran | عمران | boy | 31 | 1 | [imran](https://www.behindthename.com/name/imran), [amram](https://www.behindthename.com/name/amram) |
| Martin |  | boy | 34 |  | [martin](https://www.behindthename.com/name/martin) |
| Zayn | زين | boy | 38 |  | [zayn](https://www.behindthename.com/name/zayn) |
| Nathan |  | boy | 39 |  | [nathan](https://www.behindthename.com/name/nathan) |
| Basile |  | boy | 41 |  | [basile](https://www.behindthename.com/name/basile), [basil-1](https://www.behindthename.com/name/basil-1) |
| Théo |  | boy | 42 |  | [theo](https://www.behindthename.com/name/theo), [theodore](https://www.behindthename.com/name/theodore) |
| Augustin |  | boy | 43 |  | [augustin](https://www.behindthename.com/name/augustin), [augustus](https://www.behindthename.com/name/augustus) |
| Mathis |  | boy | 46 |  | [mathis](https://www.behindthename.com/name/mathis), [mattithiah](https://www.behindthename.com/name/mattithiah) |
| Ismaël | إسماعيل | boy | 49 | 1 | [ismail](https://www.behindthename.com/name/ismail), [ishmael](https://www.behindthename.com/name/ishmael) |
| Simon |  | boy | 50 |  | [simon-1](https://www.behindthename.com/name/simon-1) |
| Amir | أمير | boy | 56 |  | [amir-1](https://www.behindthename.com/name/amir-1) |
| Robin |  | boy | 57 |  | [robin](https://www.behindthename.com/name/robin), [robert](https://www.behindthename.com/name/robert) |
| Rayan | ريان | boy | 58 |  | [rayan](https://www.behindthename.com/name/rayan), [rayyan](https://www.behindthename.com/name/rayyan) |
| Valentin |  | boy | 59 |  | [valentin](https://www.behindthename.com/name/valentin), [valentine-1](https://www.behindthename.com/name/valentine-1) |
| Auguste |  | boy | 63 |  | [auguste-1](https://www.behindthename.com/name/auguste-1), [augustus](https://www.behindthename.com/name/augustus) |
| Naïm | نعيم | boy | 67 |  | [naim](https://www.behindthename.com/name/naim) |
| Axel |  | boy | 71 |  | [axel](https://www.behindthename.com/name/axel), [absalom](https://www.behindthename.com/name/absalom) |
| Ali | علي | boy | 73 |  | [ali-1](https://www.behindthename.com/name/ali-1) |
| Issa | عيسى | boy | 74 | 1 | [isa-1](https://www.behindthename.com/name/isa-1), [joshua](https://www.behindthename.com/name/joshua) |
| Joseph |  | boy | 77 |  | [joseph](https://www.behindthename.com/name/joseph) |
| Lucien |  | boy | 80 |  | [lucien](https://www.behindthename.com/name/lucien), [lucianus](https://www.behindthename.com/name/lucianus) |
| Yanis |  | boy | 83 |  | [yanis](https://www.behindthename.com/name/yanis), [john](https://www.behindthename.com/name/john) |
| Alexandre |  | boy | 87 |  | [alexandre](https://www.behindthename.com/name/alexandre), [alexander](https://www.behindthename.com/name/alexander) |
| Anas | أنس | boy | 90 |  | [anas](https://www.behindthename.com/name/anas) |
| Noam |  | boy | 95 |  | [noam](https://www.behindthename.com/name/noam) |
| Abel |  | boy | 98 |  | [abel](https://www.behindthename.com/name/abel) |
| Youssef | يوسف | boy | 102 | 1 | [yusuf](https://www.behindthename.com/name/yusuf), [joseph](https://www.behindthename.com/name/joseph) |
| Jean |  | boy | 103 |  | [jean-1](https://www.behindthename.com/name/jean-1), [john](https://www.behindthename.com/name/john) |
| Zayd | زيد | boy | 105 |  | [zayd](https://www.behindthename.com/name/zayd) |
| Ilyas | إلياس | boy | 106 | 1 | [ilyas](https://www.behindthename.com/name/ilyas), [elijah](https://www.behindthename.com/name/elijah) |
| Félix |  | boy | 111 |  | [felix](https://www.behindthename.com/name/felix) |
| Clément |  | boy | 114 |  | [clement](https://www.behindthename.com/name/clement) |
| Younes | يونس | boy | 116 | 1 | [yunus](https://www.behindthename.com/name/yunus), [jonah](https://www.behindthename.com/name/jonah) |
| Elias |  | boy | 117 |  | [elias](https://www.behindthename.com/name/elias), [elijah](https://www.behindthename.com/name/elijah) |
| Matteo |  | boy | 120 |  | [matteo](https://www.behindthename.com/name/matteo), [mattithiah](https://www.behindthename.com/name/mattithiah) |
| Maxime |  | boy | 130 |  | [maxime](https://www.behindthename.com/name/maxime), [maximus](https://www.behindthename.com/name/maximus) |
| Hamza | حمزة | boy | 132 |  | [hamza](https://www.behindthename.com/name/hamza) |
| Zakaria | زكريا | boy | 133 | 1 | [zakariyya](https://www.behindthename.com/name/zakariyya), [zechariah](https://www.behindthename.com/name/zechariah) |
| Octave |  | boy | 135 |  | [octave](https://www.behindthename.com/name/octave), [octavius](https://www.behindthename.com/name/octavius) |
| Hector |  | boy | 141 |  | [hector](https://www.behindthename.com/name/hector) |
| Souleymane | سليمان | boy | 142 | 1 | [sulayman](https://www.behindthename.com/name/sulayman), [solomon](https://www.behindthename.com/name/solomon) |
| Omar | عمر | boy | 144 |  | [umar](https://www.behindthename.com/name/umar) |
| Wassim | وسيم | boy | 147 |  | [wasim](https://www.behindthename.com/name/wasim) |
| Baptiste |  | boy | 148 |  | [baptiste](https://www.behindthename.com/name/baptiste) |
| Henri |  | boy | 151 |  | [henri](https://www.behindthename.com/name/henri), [henry](https://www.behindthename.com/name/henry) |
| Ahmed | أحمد | boy | 153 | 1 | [ahmad](https://www.behindthename.com/name/ahmad) |
| Amine | أمين | boy | 154 |  | [amin](https://www.behindthename.com/name/amin) |
| Thomas |  | boy | 155 |  | [thomas](https://www.behindthename.com/name/thomas) |
| Daniel |  | boy | 156 |  | [daniel](https://www.behindthename.com/name/daniel) |
| David |  | boy | 160 |  | [david](https://www.behindthename.com/name/david) |
| Nassim | نسيم | boy | 183 |  | [nasim](https://www.behindthename.com/name/nasim) |
| Jibril | جبريل | boy | 185 |  | [jibril](https://www.behindthename.com/name/jibril), [gabriel](https://www.behindthename.com/name/gabriel) |
| Jad | جاد | boy | 198 |  | [jad](https://www.behindthename.com/name/jad) |
| Yahya | يحيى | boy | 229 | 1 | [yahya](https://www.behindthename.com/name/yahya), [john](https://www.behindthename.com/name/john) |
| Sami | سامي | boy | 231 |  | [sami-2](https://www.behindthename.com/name/sami-2) |
| Khalil | خليل | boy | 246 |  | [khalil](https://www.behindthename.com/name/khalil) |
| Salim | سليم | boy | 260 |  | [salim](https://www.behindthename.com/name/salim) |
| Adil | عادل | boy | 267 |  | [adil](https://www.behindthename.com/name/adil) |
| Mehdi | مهدي | boy | 296 |  | [mahdi](https://www.behindthename.com/name/mahdi) |
| Ayman | أيمن | boy | 330 |  | [ayman](https://www.behindthename.com/name/ayman) |
| Hassan | حسن | boy | 361 |  | [hasan](https://www.behindthename.com/name/hasan) |
| Yassir | ياسر | boy | 405 |  | [yasir](https://www.behindthename.com/name/yasir) |
| Soufiane | سفيان | boy | 424 |  | [sufyan](https://www.behindthename.com/name/sufyan) |
| Ziyad | زياد | boy | 460 |  | [ziyad](https://www.behindthename.com/name/ziyad) |
| Karim | كريم | boy | 463 |  | [karim](https://www.behindthename.com/name/karim) |
| Walid | وليد | boy | 507 |  | [walid](https://www.behindthename.com/name/walid) |
| Mustapha | مصطفى | boy | 524 |  | [mustafa](https://www.behindthename.com/name/mustafa) |
| Khalid | خالد | boy | 779 |  | [khalid](https://www.behindthename.com/name/khalid) |
| Nadir | نادر | boy | 1084 |  | [nadir](https://www.behindthename.com/name/nadir) |
| Hussein | حسين | boy | 1087 |  | [husayn](https://www.behindthename.com/name/husayn), [hasan](https://www.behindthename.com/name/hasan) |
| Rami | رامي | boy | 1169 |  | [rami](https://www.behindthename.com/name/rami) |
| Tarik | طارق | boy | 1373 |  | [tariq](https://www.behindthename.com/name/tariq) |
| Hamid | حامد | boy | 1899 |  | [hamid-2](https://www.behindthename.com/name/hamid-2) |
| Louise |  | girl | 1 |  | [louise](https://www.behindthename.com/name/louise), [ludwig](https://www.behindthename.com/name/ludwig) |
| Jade |  | girl | 2 |  | [jade](https://www.behindthename.com/name/jade) |
| Ambre |  | girl | 3 |  | [ambre](https://www.behindthename.com/name/ambre), [amber](https://www.behindthename.com/name/amber) |
| Alba |  | girl | 5 |  | [alba-1](https://www.behindthename.com/name/alba-1), [albus](https://www.behindthename.com/name/albus) |
| Rose |  | girl | 6 |  | [rose](https://www.behindthename.com/name/rose) |
| Emma |  | girl | 7 |  | [emma](https://www.behindthename.com/name/emma) |
| Adèle |  | girl | 9 |  | [adele](https://www.behindthename.com/name/adele), [adela](https://www.behindthename.com/name/adela) |
| Alice |  | girl | 10 |  | [alice](https://www.behindthename.com/name/alice), [adelaide](https://www.behindthename.com/name/adelaide) |
| Iris |  | girl | 11 |  | [iris](https://www.behindthename.com/name/iris) |
| Agathe |  | girl | 13 |  | [agathe](https://www.behindthename.com/name/agathe), [agatha](https://www.behindthename.com/name/agatha) |
| Inaya | عناية | girl | 14 |  | [inaya](https://www.behindthename.com/name/inaya) |
| Anna |  | girl | 15 |  | [anna](https://www.behindthename.com/name/anna), [hannah](https://www.behindthename.com/name/hannah) |
| Noor | نور | girl | 16 | 1 | [nur](https://www.behindthename.com/name/nur) |
| Lina | لينا | girl | 17 |  | [lina-1](https://www.behindthename.com/name/lina-1) |
| Victoire |  | girl | 22 |  | [victoire](https://www.behindthename.com/name/victoire), [victor](https://www.behindthename.com/name/victor) |
| Jeanne |  | girl | 23 |  | [jeanne](https://www.behindthename.com/name/jeanne), [john](https://www.behindthename.com/name/john) |
| Léonie |  | girl | 25 |  | [leonie](https://www.behindthename.com/name/leonie), [leonius](https://www.behindthename.com/name/leonius) |
| Eva |  | girl | 26 |  | [eva](https://www.behindthename.com/name/eva), [eve](https://www.behindthename.com/name/eve) |
| Esmée |  | girl | 27 |  | [esmee](https://www.behindthename.com/name/esmee), [esme10](https://www.behindthename.com/name/esme10) |
| Sofia |  | girl | 29 |  | [sofia](https://www.behindthename.com/name/sofia), [sophia](https://www.behindthename.com/name/sophia) |
| Zoé |  | girl | 30 |  | [zoe](https://www.behindthename.com/name/zoe) |
| Luna |  | girl | 33 |  | [luna](https://www.behindthename.com/name/luna) |
| Chloé |  | girl | 34 |  | [chloe](https://www.behindthename.com/name/chloe) |
| Victoria |  | girl | 36 |  | [victoria](https://www.behindthename.com/name/victoria), [victor](https://www.behindthename.com/name/victor) |
| Alix |  | girl | 37 |  | [alix](https://www.behindthename.com/name/alix), [adelaide](https://www.behindthename.com/name/adelaide) |
| Romane |  | girl | 39 |  | [romane](https://www.behindthename.com/name/romane), [roman](https://www.behindthename.com/name/roman) |
| Lucie |  | girl | 43 |  | [lucie](https://www.behindthename.com/name/lucie), [lucius](https://www.behindthename.com/name/lucius) |
| Margot |  | girl | 46 |  | [margot](https://www.behindthename.com/name/margot), [margaret](https://www.behindthename.com/name/margaret) |
| Gabrielle |  | girl | 47 |  | [gabrielle](https://www.behindthename.com/name/gabrielle), [gabriel](https://www.behindthename.com/name/gabriel) |
| Théa |  | girl | 51 |  | [thea](https://www.behindthename.com/name/thea), [dorothea](https://www.behindthename.com/name/dorothea) |
| Yasmine | ياسمين | girl | 52 |  | [yasmin](https://www.behindthename.com/name/yasmin), [jasmine](https://www.behindthename.com/name/jasmine) |
| Mila |  | girl | 54 |  | [mila](https://www.behindthename.com/name/mila) |
| Céleste |  | girl | 55 |  | [celeste](https://www.behindthename.com/name/celeste), [caelestis](https://www.behindthename.com/name/caelestis) |
| Aria |  | girl | 59 |  | [aria-1](https://www.behindthename.com/name/aria-1) |
| Suzanne |  | girl | 62 |  | [suzanne](https://www.behindthename.com/name/suzanne), [susanna](https://www.behindthename.com/name/susanna) |
| Capucine |  | girl | 63 |  | [capucine](https://www.behindthename.com/name/capucine) |
| Sarah | سارة | girl | 64 |  | [sarah](https://www.behindthename.com/name/sarah) |
| Inès |  | girl | 67 |  | [ines](https://www.behindthename.com/name/ines), [agnes](https://www.behindthename.com/name/agnes) |
| Diane |  | girl | 69 |  | [diane](https://www.behindthename.com/name/diane), [diana](https://www.behindthename.com/name/diana) |
| Lily |  | girl | 70 |  | [lily](https://www.behindthename.com/name/lily) |
| Constance |  | girl | 72 |  | [constance](https://www.behindthename.com/name/constance), [constans](https://www.behindthename.com/name/constans) |
| Amelia |  | girl | 81 |  | [amelia](https://www.behindthename.com/name/amelia), [amalia](https://www.behindthename.com/name/amalia) |
| Joséphine |  | girl | 88 |  | [josephine](https://www.behindthename.com/name/josephine), [joseph](https://www.behindthename.com/name/joseph) |
| Aïcha | عائشة | girl | 98 |  | [aisha](https://www.behindthename.com/name/aisha) |
| Garance |  | girl | 106 |  | [garance](https://www.behindthename.com/name/garance) |
| Amira | أميرة | girl | 108 |  | [amira-1](https://www.behindthename.com/name/amira-1), [amir-1](https://www.behindthename.com/name/amir-1) |
| Clara |  | girl | 111 |  | [clara](https://www.behindthename.com/name/clara) |
| Salomé |  | girl | 119 |  | [salome](https://www.behindthename.com/name/salome) |
| Aliya | عالية | girl | 120 |  | [aliya-1](https://www.behindthename.com/name/aliya-1), [ali-1](https://www.behindthename.com/name/ali-1) |
| Mathilde |  | girl | 121 |  | [mathilde](https://www.behindthename.com/name/mathilde), [matilda](https://www.behindthename.com/name/matilda) |
| Amina | آمنة | girl | 122 |  | [amina](https://www.behindthename.com/name/amina) |
| Célia |  | girl | 124 |  | [celia](https://www.behindthename.com/name/celia), [caelius](https://www.behindthename.com/name/caelius) |
| Asma | أسماء | girl | 166 |  | [asma](https://www.behindthename.com/name/asma) |
| Tasnim | تسنيم | girl | 174 | 1 | [tasnim](https://www.behindthename.com/name/tasnim) |
| Safia | صفية | girl | 178 |  | [safiyya](https://www.behindthename.com/name/safiyya), [safi](https://www.behindthename.com/name/safi) |
| Yara | يارا | girl | 182 |  | [yara-1](https://www.behindthename.com/name/yara-1) |
| Hana | هناء | girl | 199 |  | [hana-1](https://www.behindthename.com/name/hana-1) |
| Layla | ليلى | girl | 211 |  | [layla](https://www.behindthename.com/name/layla) |
| Soumaya | سمية | girl | 237 |  | [soumaya](https://www.behindthename.com/name/soumaya), [sumayya](https://www.behindthename.com/name/sumayya) |
| Isra | إسراء | girl | 238 |  | [isra](https://www.behindthename.com/name/isra) |
| Kenza | كنزة | girl | 242 |  | [kenza](https://www.behindthename.com/name/kenza), [kanza](https://www.behindthename.com/name/kanza) |
| Salma | سلمى | girl | 249 |  | [salma](https://www.behindthename.com/name/salma) |
| Sana | سناء | girl | 264 |  | [sana-1](https://www.behindthename.com/name/sana-1), [sanaa](https://www.behindthename.com/name/sanaa) |
| Sakina | سكينة | girl | 374 | 1 | [sakina](https://www.behindthename.com/name/sakina) |
| Malak | ملاك | girl | 396 |  | [malak](https://www.behindthename.com/name/malak) |
| Imane | إيمان | girl | 440 | 1 | [iman](https://www.behindthename.com/name/iman) |
| Hiba | هبة | girl | 444 |  | [hiba](https://www.behindthename.com/name/hiba) |
| Farah | فرح | girl | 498 |  | [farah](https://www.behindthename.com/name/farah) |
| Amal | أمل | girl | 522 | 1 | [amal-1](https://www.behindthename.com/name/amal-1) |
| Rahma | رحمة | girl | 565 | 1 | [rahma](https://www.behindthename.com/name/rahma) |
| Bayane | بيان | girl | 635 | 3 | — |
| Kawthar | كوثر | girl | 912 | 1 | [kawthar](https://www.behindthename.com/name/kawthar) |
| Nawal | نوال | girl | 1163 |  | [nawal](https://www.behindthename.com/name/nawal) |
| Ilham | إلهام | girl | 1170 |  | [ilham](https://www.behindthename.com/name/ilham) |
| Houda | هدى | girl | 1795 | 1 | [huda](https://www.behindthename.com/name/huda) |
| Wafa | وفاء | girl | 3360 |  | [wafa](https://www.behindthename.com/name/wafa) |
