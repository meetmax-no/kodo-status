# Sette opp vakten — steg for steg

Alt gjøres i nettleseren. Ingen kommandolinje, ingen installering.

Sett av ti minutter. Du gjør dette én gang.

---

## Hva du faktisk setter opp

Vakten er et lite program som spør to av podene våre «lever du?» hvert femte
minutt, og skriver svaret til dette repoet. Statussiden leser det svaret.

Programmet må ligge et sted som kan kjøre det på klokkeslett. Vi prøvde
GitHub først; de kjørte det aldri. Cloudflare gjør det.

Du trenger tre ting: en Cloudflare-konto, et passord som lar programmet
skrive til dette repoet, og fem minutter til å lime inn kode.

---

## Del 1 — Lag et passord som lar vakten skrive hit

Vakten må kunne skrive `status.json` til dette repoet. Til det trenger den et
eget passord fra GitHub — et som *bare* kan røre dette ene repoet.

1. Gå til **github.com** → klikk profilbildet øverst til høyre → **Settings**
2. Helt nederst i menyen til venstre: **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens**
4. Knappen **Generate new token**

Fyll ut slik:

| Felt | Hva du velger |
|---|---|
| Token name | `kodo-vakt` |
| Resource owner | **meetmax-no** — ikke ditt eget navn |
| Expiration | Så langt fram som mulig. Skriv datoen i kalenderen. |
| Repository access | **Only select repositories** → velg **kodo-status** |

Så, under **Permissions → Repository permissions**, finn linja **Contents** og
sett den til **Read and write**.

La alt annet stå urørt. Vakten skal ikke kunne noe mer enn å skrive til dette
ene repoet.

5. **Generate token** nederst
6. **Kopier passordet med én gang.** GitHub viser det bare denne ene gangen.
   Lim det inn et sted midlertidig — du skal bruke det i Del 3.

> Er organisasjonen satt opp med godkjenning, står tokenet som «Pending» til
> en org-admin godkjenner det. Da virker ikke vakten før det er gjort.

---

## Del 2 — Lag programmet hos Cloudflare

1. Gå til **dash.cloudflare.com** og logg inn
2. I menyen til venstre: **Compute (Workers)** — eller **Workers & Pages** på
   eldre kontoer
3. Knappen **Create** → velg **Start with Hello World!** → **Get started**
4. Gi det navnet **kodo-vakt** → **Deploy**

Nå har du et tomt program som ikke gjør noe. Vi bytter ut innholdet:

5. Klikk **Edit code** (eller **</> Edit code** øverst til høyre)
6. Merk alt i redigeringsvinduet og slett det
7. Åpne fila `worker/src/index.mjs` her i repoet, kopier **hele** innholdet,
   og lim det inn
8. Klikk **Deploy** øverst til høyre

Programmet er nå ute, men det mangler passordene og har ingen klokke.

---

## Del 3 — Legg inn de fem passordene

Fortsatt inne på `kodo-vakt`:

1. Klikk **Settings** (fanen øverst)
2. Finn **Variables and Secrets**
3. For hvert av de fem under: **+ Add** → velg **Secret** som type → skriv
   navnet i venstre felt og verdien i høyre → **Save**

| Navn (skriv nøyaktig slik) | Verdi |
|---|---|
| `INTERNAL_RPC_SECRET` | Samme verdi som står i Vercel under samme navn |
| `GITHUB_TOKEN` | Passordet du kopierte i Del 1 |
| `TELEGRAM_BOT_TOKEN` | Samme som i Vercel |
| `TELEGRAM_CHAT_ID` | Samme som i Vercel |
| `TRIGGER_SECRET` | Finn på noe langt og tilfeldig. Bare du trenger den. |

**Secret**, ikke **Text**: da er verdien kryptert og kan ikke leses ut igjen
etterpå, verken av deg eller andre.

Klikk **Deploy** når alle fem står der.

---

## Del 4 — Sett klokka

Uten dette kjører programmet aldri av seg selv.

1. Fortsatt under **Settings**
2. Finn **Trigger Events** → **Cron Triggers** → **+ Add**
3. Skriv inn: `*/5 * * * *`
4. **Add** → **Deploy**

Det betyr «hvert femte minutt».

---

## Del 5 — Kjør en sjekk med én gang

Du trenger ikke vente på klokka. Vakten kan startes fra adressefeltet.

1. På Worker-siden i Cloudflare, finn adressen til programmet. Den ser slik
   ut: `https://kodo-vakt.<noe>.workers.dev`
2. Lim den inn i nettleseren, og legg til nøkkelen din på slutten:

```
https://kodo-vakt.<noe>.workers.dev/?key=DIN_TRIGGER_SECRET
```

Der `DIN_TRIGGER_SECRET` er verdien du fant på i Del 3.

Du får et svar som dette:

```
Sjekk kjørt 2026-09-09T19:28:45.514Z

Samlet: up
  admin  up
  demo   up

Varsler sendt: 0

Se status.kodovault.no om et minutt.
```

Ser du det, virker alt: programmet nådde podene, skrev til repoet, og
statussiden oppdaterer seg innen et minutt.

Får du «Feil eller manglende nøkkel», er `TRIGGER_SECRET` skrevet feil i
Del 3. Får du en feilmelding om GitHub, er det `GITHUB_TOKEN` som er feil
eller ikke godkjent ennå.

> Nøkkelen i adressen havner i nettleserhistorikken. Det er en bevisst
> avveining: den låser opp én ting — å kjøre en sjekk nå, som klokka gjør
> hvert femte minutt uansett. Bruk en lang, tilfeldig verdi, og bytt den om
> den kommer på avveie.

**Vil du se det innenfra:** klikk **Logs** på Worker-siden. Der kommer linjer
som begynner med `[vakt]` for hver kjøring, og der står feilene hvis noe går
galt.

---

## Hva som skjer hvis passordet utløper

Passordet fra Del 1 har en utløpsdato. Når den passerer, kan vakten fortsatt
sjekke podene, men ikke skrive svaret hit.

Da skjer to ting av seg selv:

- Du får en melding på Telegram om at vakten ikke får skrevet
- Statussiden slutter å vise grønt og sier «Ukjent — ingen fersk sjekk»

Den skal aldri stå grønn på gamle tall. En side som melder at alt er i orden
mens noe er nede, er verre enn ingen side.

Lag likevel et nytt passord før datoen, og bytt det ut i Del 3. Varslene er et
sikkerhetsnett, ikke en plan.
