# Movie Vault

Privat oversikt over Blu-ray-, 4K- og DVD-samlingen (ca. 2300 titler). Appen er vanlig HTML, CSS og JavaScript uten byggesteg. Den kan åpnes rett fra en fil, kjøres fra en enkel webserver, eller ligge på nett som en app som kan installeres på mobil og PC, og som åpner seg selv uten nett.

Selve appen er på engelsk. Denne README-en er på norsk.

## Hva appen kan

- **Samlingsoversikt.** Alle titler vises som kort med cover, eller som kompakt liste («List view»). Du kan søke på tittel, strekkode og notater, filtrere på seksjon, format og sett/ikke sett, og sortere (A–Z, nyeste først, usette først, duplikater først). Øverst står tellere for antall titler, duplikater og usorterte titler, og en samlet samlingsverdi som kan justeres med historikk og «Rollback».
- **Hyller/seksjoner.** Titlene er ordnet i seksjoner (hyller) slik de sto i den opprinnelige samlelista, for eksempel «TV ROOM». Hver tittel kan flyttes til en annen seksjon, og du kan opprette nye seksjoner.
- **Hylla «UNSORTED / NOT PLACED».** Nye innkjøp havner automatisk her til du har bestemt hvor de skal stå. Knappen «Unsorted» viser bare disse titlene. Hvert usortert kort har knappen **Place on shelf**, som flytter filmen til en hylle (eller en ny hylle) med ett trykk.
- **Flytte mange på én gang.** Trykk **Select**, merk kortene, og bruk linja nederst: «Move to shelf…», «Mark seen» eller «Mark unseen». «Select all» merker alle titlene i det gjeldende filteret.
- **Rask visning.** Kortene tegnes etter hvert som du blar, så samlingen åpner på et blunk også på mobil. Seksjonsfilteret viser antall titler per hylle, og «Clear filters» nullstiller søk og filtre.
- **Sett / ikke sett.** Hver tittel kan merkes som sett. Filteret «Seen» og sorteringen «Unseen first» gjør det enkelt å finne noe du ikke har sett ennå.
- **Strekkodeskanning på mobil.** Fanen «Add / scan» bruker kameraet til å lese strekkoden på plata, og kan slå opp et tittelforslag. Kameraet krever https eller localhost, så det virker på den publiserte siden, men ikke hvis du åpner `index.html` direkte fra disk. Ved feilsøk får du en lenke for å google strekkoden.
- **Mobilen som skanner for PC-en.** På «Add / scan» på PC-en trykker du **Use phone as scanner**, skanner QR-koden med mobilens vanlige kamera-app, og strekkodene du skanner på mobilen dukker opp live på PC-en. Se avsnittet «Mobilen som skanner for PC-en» under.
- **Har jeg den allerede?** Når du skanner en strekkode eller skriver en tittel som allerede finnes i samlingen, sier appen fra med en gang («You already own this…» / «You already have…»). Det er nyttig i butikken.
- **Angre.** Etter at du har slettet en film eller flyttet titler til en hylle, kan du angre i noen sekunder.
- **Automatiske covers.** Se avsnittet «Coverbilder» under.
- **«Blueprint»-eksport av samlelista.** Fanen «Blueprint export» lager en samleliste i samme stil som den gamle Word-lista: tittel øverst, seksjonsnavn og stjerne-punkter. Den kan lastes ned som HTML (kan åpnes i Word) eller TXT, eller skrives ut / lagres som PDF.
- **Backup.** Menyen «Backup ▾» eksporterer hele samlingen som en JSON-fil (eller et regneark, CSV) og importerer den igjen. Ved import velger du **Merge** (slå sammen) eller **Replace all**, og «Undo last import» angrer. En rød prikk på Backup-knappen minner deg på å ta backup når det er endringer som ikke er sikret.

## Mobilen som skanner for PC-en

Praktisk når du sitter ved PC-en med en stabel plater: telefonen er skanneren, og PC-en viser tittel, advarsel om duplikat og knapper for å legge filmen til.

1. Åpne appen på PC-en (`https://daviscollection.vercel.app`), gå til **Add / scan** og trykk **Use phone as scanner**. Det kommer opp en QR-kode.
2. Skann QR-koden med mobilens vanlige kamera-app og åpne lenken. Appen åpnes på telefonen i **Remote scanner**-modus, koblet til PC-en. Ingen konto eller innlogging trengs, og samlingen trenger ikke ligge på telefonen.
3. Trykk **Start scan** på telefonen og hold strekkoden foran kameraet. Kameraet fortsetter å skanne etter hvert treff (samme kode sendes ikke på nytt før den har vært ute av bildet i ca. 2,5 sekunder), og telefonen vibrerer for hver kode som sendes. Under kameraet ser du hva PC-en svarte: tittelen, eller «Already in collection: …».
4. På PC-en kommer hver kode i panelet **Scanned on phone** (øverst på Add / scan) med strekkode, tittelforslag og, hvis du har den fra før, «You already own: TITTEL (HYLLE)». Per kode kan du velge **Add to Unsorted** (legger filmen på hylla UNSORTED / NOT PLACED med tittel og strekkode), **Edit first** (fyller ut skjemaet «Add a movie», så du kan rette tittel eller format før du legger til) eller **Dismiss**. **Add all to Unsorted** legger til alle som har tittel og som du ikke eier fra før. Etter å ha lagt til kan du angre i noen sekunder (Undo). Samme kode to ganger gir ikke to rader, den eksisterende raden blinker.
5. Du kan lukke QR-vinduet. Økten fortsetter så lenge pillen **«📱 Phone scanner connected · Stop»** vises nederst til venstre. Trykk **Stop** når du er ferdig. Bare én telefon er koblet til om gangen.
6. På telefonen tar **Use this phone normally** deg ut av Remote scanner og tilbake til vanlig app.

Slik virker det: PC-en og telefonen kobles direkte til hverandre (WebRTC, via biblioteket PeerJS). Den gratis, offentlige signalserveren `0.peerjs.com` brukes bare til å få de to til å finne hverandre, og vi har ingen egen server. Det som sendes er kun strekkodetallene, kryptert mellom enhetene, og de lagres ikke noe sted. Strekkodeoppslaget (upcitemdb) og sjekken mot samlingen gjøres på PC-en. PeerJS og QR-biblioteket lastes først når du bruker funksjonen (fast versjon fra jsDelivr, med SRI-sjekk), så resten av appen er upåvirket.

Sikkerhet: PC-ens tilfeldige id i QR-koden (ca. 80 bits) er den eneste tilgangskontrollen. Den som kjenner lenken, mens økten pågår, kan sende strekkoder til PC-vinduet. Ikke del bilde av QR-koden, og trykk **Stop** når du er ferdig. PC-en godtar bare riktig utformede strekkoder og ignorerer alt annet.

Feilsøking:

- **Begge enhetene trenger internett.** De trenger ikke være på samme Wi-Fi. Står det at telefonen eller PC-en ikke får lastet bibliotek eller nå «pairing server», er det nettet som mangler eller blokkerer `cdn.jsdelivr.net` / `0.peerjs.com`.
- **Hold PC-vinduet åpent.** Lukker du fanen eller lar PC-en gå i dvale, står det «PC not found — is the PC window still open?» på telefonen. Åpne vinduet igjen og trykk **Try again** (ny QR-kode hvis du måtte starte økten på nytt).
- **Noen nettverk blokkerer direkte forbindelse mellom enheter** (bedrifts- og gjestenett, noen mobilnett). Prøv mobildata på telefonen eller et annet Wi-Fi.
- Slår telefonskjermen seg av, stopper kameraet. Appen prøver å holde skjermen våken, og kobler seg til PC-en igjen av seg selv når den kommer tilbake (opptil fem forsøk, deretter **Try again**).
- Det gratis strekkodeoppslaget tillater ca. 100 oppslag om dagen, og det teller på PC-ens nett.
- Testing: `window.MV_PEER_OPTIONS` (alle PeerJS-valg) eller `?peerhost=localhost:9000` peker appen mot en lokal `peerjs`-server (kun localhost/127.0.0.1) i stedet for den gratis skyen.

## Publisering

### Vercel (slik siden ligger nå)

GitHub-repoet har `https://daviscollection.vercel.app` som hjemmeside, og siden publiseres fra Vercel rett fra `main`-grenen.

- **Oppdatering skjer automatisk.** Når du pusher eller merger til `main`, lager Vercel en ny utgave av siden av seg selv, vanligvis på under ett minutt. Det er ingenting å bygge: filene serveres akkurat som de ligger i repoet.
- **Ingen `vercel.json` er nødvendig.** Vercel sender `Cache-Control: public, max-age=0, must-revalidate` for statiske filer, så nettleseren sjekker alltid om det finnes en nyere versjon. Service workeren (`sw.js`) henter dessuten alltid ferske filer når du er på nett.
- **Hvis en endring ikke dukker opp:** åpne prosjektet i Vercel-dashboardet og sjekk at siste deployment under «Deployments» er «Ready», og at Production Branch er `main`. Under Settings → Build and Deployment skal Framework Preset være «Other», og Output Directory skal stå tom (siden ligger i rotmappa).

### Alternativ: GitHub Pages

1. Gå til repoet på GitHub → **Settings → Pages**.
2. Under «Build and deployment» velger du **Source: Deploy from a branch**.
3. Velg **Branch: `main`** og mappe **`/ (root)`**, og trykk Save.
4. Etter et minutt eller to ligger siden på `https://nio-lockscreen.github.io/Daviscollection/`.

(Pages på et *privat* repo krever betalt GitHub-plan. Det er ikke aktuelt så lenge repoet er offentlig.) Filen `.nojekyll` i rotmappa gjør at GitHub Pages serverer filene som de er. Alle stier i appen er relative, så den virker også i en undermappe som `/Daviscollection/`.

### Hva er offentlig og hva er privat?

Repoet er offentlig, og siden på nett kan åpnes av alle som kjenner adressen. I repoet ligger **bare startlista med filmtitler** (`js/seed-data.js`). **Ingen av dine egne endringer ligger i repoet eller på serveren.** Nye filmer, covers du har valgt, sett/ikke sett, samlingsverdi og innstillinger lagres bare i nettleseren din (se «Hvor lagres dataene?»).

## Kjøre lokalt

Velg det som passer:

- `npx serve .` i prosjektmappa, og åpne adressen som skrives ut.
- `python3 -m http.server 8000`, og åpne `http://localhost:8000`.
- Dobbeltklikk på `index.html`. Det fungerer for det aller meste, men da registreres ikke service workeren (ingen installasjon og ingen offline-støtte), og kameraskanneren virker ikke. **Kameraet/strekkodeskanneren krever https eller localhost.**

Husk at hver adresse har sin egen lagring (se under): data du legger inn på `localhost` finnes ikke på `daviscollection.vercel.app`, og omvendt.

## Hvor lagres dataene?

- Alt du endrer lagres i **denne nettleserens `localStorage`**. Det betyr at dataene er **per enhet og per nettleser**, og at det **ikke finnes noen synkronisering**. Telefonen og PC-en har hver sin kopi.
- **Flytt data mellom mobil og PC** med **Backup ▾ → Export JSON backup** på den ene enheten og **Import JSON backup** på den andre.
- **Ta jevnlig backup som sikkerhetskopi**, for eksempel etter at du har lagt inn flere nye innkjøp. Legg filen et trygt sted (e-post til deg selv, skylagring e.l.). Hvis nettleserdata slettes, privat modus brukes, eller appen fjernes, forsvinner endringene dine hvis du ikke har en backup.
- **iPhone/Safari:** Safari kan slette data fra nettsteder du ikke har brukt på ca. 7 dager, med mindre appen er lagt til på hjemskjermen. Legg derfor appen til på hjemskjermen (se under) **og** ta backup (Export JSON).
- Startlista fra `js/seed-data.js` brukes bare første gang, når nettleseren ikke har lagrede data fra før.

## Installere som app

Appen kan installeres, åpner da i eget vindu uten nettleser-menyer, og har eget ikon.

- **iPhone (Safari):** åpne siden i Safari → trykk **Del**-knappen → **Legg til på Hjem-skjerm** (Add to Home Screen) → Legg til.
- **Android (Chrome):** åpne siden → meny (⋮) → **Installer app** (Install app), eller **Legg til på startskjermen** (Add to home screen).
- **PC (Chrome eller Edge):** trykk på installasjonsikonet ytterst i adressefeltet, eller velg menyen → **Installer Movie Vault**.

Etter installasjon virker appens egne filer uten nett. Samlinga di ligger i nettleserens lagring og vises også uten nett. Coverbilder, oppslag av strekkoder, reserveskanneren og «mobilen som skanner» (lastes fra en CDN) trenger derimot nett. Coverbilder hentes fra internett og vises uten nett bare hvis nettleseren har dem i sin egen hurtigbuffer.

## Coverbilder

- **Automatisk.** Når et kort uten cover kommer til syne mens du blar, slår appen opp filmen og lagrer plakaten. Wikipedia brukes til å fastslå *hvilken* film tittelen er, og om flere filmer deler navnet. Plakaten hentes så fra TMDB, iTunes eller Wikipedia, og bare når tittel og år stemmer med den filmen. Bildet må laste og være stående (plakatformat), slik at pressefoto, logoer og tittelskjermer aldri brukes.
- **Heller ingen plakat enn feil plakat.** Er tittelen tvetydig, får kortet ingen automatisk plakat. Eksempler: HEAT (1986 og 1995), TITANIC, PSYCHO, eller når både «X» og «The X» finnes som filmer. Det samme gjelder forkortede og feilstavede titler (GARP, RAGINGBULL) og bokser med flere filmer («1, 2 & 3», TRILOGY). Velg da plakaten selv med **Find poster**.
- **Manuelt.** Trykk **Find poster** (i «Add / scan» eller i detaljvisningen til en film). Da åpnes en velger med forslag fra TMDB, iTunes og Wikipedia. Trykk på riktig plakat, endre søketeksten og søk på nytt, bruk **Google Images**, eller lim inn en egen bilde-URL. En plakat du fjerner eller bytter ut, blir husket som avvist og foreslås ikke igjen. En plakatlenke som slutter å virke, fjernes automatisk, og kortet får knappen «Find poster» igjen.
- **Cover settings** (tannhjulet i plakatvelgeren): egen TMDB-nøkkel (valgfritt), land for iTunes-søk, **Load missing covers** (går gjennom alle titler uten plakat, med fremdrift og Avbryt), og tømming av cover-mellomlageret.
- **Plakater fra den gamle versjonen.** Den forrige versjonen av appen valgte ofte feil plakat (cirka hver fjerde var feil film, eller et foto/logo). Har du brukt den, sier appen fra ved oppstart. **Check old covers** i Cover settings sjekker alle gamle plakater med den nye logikken. Bekreftede plakater beholdes uten merking. Usikre får merket **Check cover**, med knappene **Keep** og **Wrong cover?** (som viser et forslag først). Ingenting byttes ut uten at du velger det. Sorteringen «Covers to review first» samler alle som bør sees på.
- **TMDB-nøkkel.** Appen har en innebygd TMDB-nøkkel, så TheMovieDB brukes automatisk. Nøkkelen ligger obfuskert i `js/covers.js` (`TMDB_BUILTIN_KEY`) for å unngå at den står i klartekst i det offentlige repoet. En nettleser må likevel sende den til TMDB, så den er ikke hemmelig. Legger du inn en egen nøkkel under Cover settings, brukes den i stedet. Den lagres bare i nettleseren og er aldri med i backup-filer. Tøm feltet for å gå tilbake til den innebygde.

### Sjekke at plakatene blir riktige

`tests/cover-audit/` inneholder en fasit med 208 titler fra samlingen, merket med riktig film. Det er et tilfeldig utvalg fra alle hyllene pluss kjente feller. Åpne `tests/cover-audit/` på nettsiden (for eksempel `https://daviscollection.vercel.app/tests/cover-audit/`) eller lokalt, og trykk **Run audit**. Siden kjører appens ekte automatiske plakatoppslag på hver tittel. Den viser om plakaten er riktig film, feil film, ikke en plakat, en gjetning på en tvetydig tittel, eller bevisst hoppet over. Siden bare leser og endrer ikke samlingen.

Resultat ved siste kjøring. iTunes kunne ikke nås fra testmiljøet, så tallene gjelder Wikipedia og TMDB. Alle plakatene er i tillegg sjekket for øyet.

| | Før | Nå, uten TMDB | Nå, med innebygd TMDB-nøkkel |
|---|---|---|---|
| Automatiske plakater | 150 | 116 | 118 (105 fra TMDB) |
| Riktig film med ekte plakat | ca. 69 % | 97 % | 97 % |
| Feil film | 25 | 0 | 0 |
| Foto/logo i stedet for plakat | ca. 11 | 0 | 0 |
| Gjetning på tvetydig tittel | 11 | 3 | 3 |
| Entydige titler med riktig plakat | 67 % | 66 % | 67 % |

De tre gjetningene er alle sannsynlige: ROBOCOP → 1987, DESPERATE HOURS → 1990, SEVEN → 1995.

### Slik får du en gratis TMDB-nøkkel

Trengs bare hvis den innebygde nøkkelen slutter å virke (appen sier da fra med «TMDB rejected the API key»), eller hvis du vil bruke din egen.

1. Opprett en gratis konto på <https://www.themoviedb.org/signup> og bekreft e-postadressen.
2. Logg inn og gå til <https://www.themoviedb.org/settings/api> (profilbildet → Settings → API).
3. Velg **Create** (eller «Request an API key») og deretter typen **Developer**. Godta vilkårene.
4. Fyll ut skjemaet kort: navn på applikasjonen (f.eks. «Movie Vault»), adressen til siden din, og en kort beskrivelse (f.eks. «Personal, non-commercial movie collection manager»), samt kontaktinformasjon. Privat, ikke-kommersiell bruk er gratis.
5. Kopier **API Key** (v3, en lang rekke tegn) fra API-siden, og lim den inn under **Cover settings** i plakatvelgeren.

TMDB krever kildehenvisning: *This product uses the TMDB API but is not endorsed or certified by TMDB.*

## Filoversikt

```
index.html             Siden (markup) og <head> med manifest, ikoner og meta-tagger
manifest.webmanifest   Gjør appen installerbar (navn, farger, ikoner)
sw.js                  Service worker: offline-støtte for appens egne filer
.nojekyll              Tom fil, trengs bare for GitHub Pages
css/styles.css         Alt av utseende
js/seed-data.js        Startlista med titler (brukes bare første gang)
js/storage.js          Lagring i localStorage, normalisering, JSON-backup, blueprint-eksport
js/covers.js           Automatisk cover-oppslag og plakatvelgeren
js/scanner.js          Strekkodeoppslag og kameraskanner
js/remote-scan.js      Mobilen som skanner for PC-en (QR-kode, PeerJS, kø med skannede koder)
js/app.js              Tilstand, oppstart, visning av kort, redigering og verdi
js/pwa.js              Registrerer service workeren (bare på http/https, ikke fra fil)
icons/                 Appikonet (icon.svg og de ferdige PNG-filene)
tests/cover-audit/     Fasit og testside for automatiske plakater (se «Sjekke at plakatene blir riktige»)
```

Skriptene er vanlige `<script>`-tagger (ikke moduler) som lastes i den rekkefølgen som står i `index.html`, slik at appen også virker når `index.html` åpnes direkte fra disk. `js/pwa.js` lastes sist.

### Oppdateringer og cache-versjon

Service workeren henter alltid filene fra nettet først, og bruker den lagrede kopien bare når du er uten nett. Når du publiserer en endring og åpner appen på nett, får du derfor den nye versjonen med det samme (på installert app: lukk og åpne den én gang, eller last siden på nytt). Dataene dine i nettleseren påvirkes ikke av oppdateringer.

Skal du tvinge alle installerte kopier til å laste ned alt på nytt, endrer du `CACHE_VERSION` øverst i `sw.js` (for eksempel fra `'v1'` til `'v2'`). Den nye service workeren henter da alle filer på nytt og sletter den gamle cachen. Legger du til en ny fil i appen (for eksempel et nytt skript i `js/`), tar du den også med i `SHELL`-lista i `sw.js` og øker versjonen, slik at den er tilgjengelig uten nett fra første stund.

Ikonene er laget ut fra `icons/icon.svg` (vanlig ikon) og `icons/icon-maskable.svg` (full-bleed, brukes til maskable-ikonet og iPhone-ikonet).
