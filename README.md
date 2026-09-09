# Ko | Do · Vault — status

Driftsvakt og statusside for [kodovault.no](https://kodovault.no).

**Siden:** [status.kodovault.no](https://status.kodovault.no)
(reserveadresse: `meetmax-no.github.io/kodo-status` — den virker også om DNS-en ryker)

## Hvorfor dette repoet finnes

En statusside som ligger på det den rapporterer om, er nede akkurat når den
trengs. Vakten og siden står derfor helt utenfor Vercel, i et repo for seg selv.

Det som faktisk ryker er sjelden Vercels edge — det er *vårt oppsett* på
Vercel: en feilet deploy, et alias som peker feil, en pinnet tilbakerulling.
En vakt på samme plattform ville vært stille gjennom alle tre.

## Hvorfor vakten kjører på Cloudflare

Første forsøk lå i GitHub Actions. Den kjørte aldri på timeplan: to timer,
~24 tapte slots, null planlagte kjøringer — bare de manuelle. GitHubs egen
dokumentasjon kaller `schedule` best effort, med forsinkelser ved høy last og
«some queued jobs may be dropped». Fem minutter er det korteste de tillater,
og det de dropper først. **En vakt som bare går når noen ber den, er ikke en
vakt.**

Cloudflare Workers har en ekte planlegger, og vi har allerede
databehandleravtale og TIA der — det var den eneste innvendingen, og den holdt
ikke. Workeren behandler dessuten ingen personopplysninger: den spør to
helse-endepunkter og skriver «oppe/nede».

Sideeffekten er at det siste forbeholdet i D-149 forsvant. Med Actions sto
vakten *og* siden hos GitHub, så en GitHub-nedetid tok begge. Nå er de tre
uavhengige: podene på Vercel, vakten hos Cloudflare, siden på GitHub Pages.

## Hva vakten ser — og ikke ser

| Sjekkes | Hvordan |
|---|---|
| Administrasjon | `admin.kodovault.no/api/internal/health` hvert 5. min |
| Kundepod (demo) | `demo.kodovault.no/api/health` hvert 5. min |

**Kundepodene sjekkes ikke én for én herfra.** Dette repoet er offentlig, og en
liste over hvem som er kunde hører ikke hjemme her. Sertifikatsveipet som dekker
hver pod kjører på admin, og svaret går til Telegram — aldri hit.

Statussiden sier dette rett ut. En side som melder «alt i orden» mens en kunde
er nede, er verre enn ingen side.

## Strike-reglene

```
grønn  →  ✕  →  ORANSJE  →  ✕  →  RØD → Telegram
                   │
                   ✓ → grønn
```

- **Oransje varsler ikke.** Den står på siden, ikke på telefonen. Ellers vekkes
  du av nettverkshikke, skrur av lyden, og er stille når det gjelder.
- **Én grønn sletter oransje.** Krever man to, står siden gul lenge etter at alt
  er bra — og da slutter man å se på fargen.
- **Rødt varsler på overgang, ikke per sjekk.** Seks timers nedetid er 72
  mislykkede sjekker. Du skal ha én melding når det blir rødt og én når det er
  tilbake.
- Med 5 minutters intervall: rødt etter ca. 10 minutter.

## Filene

| Fil | Hva |
|---|---|
| `worker/src/index.mjs` | Vakten. Ingen avhengigheter, ingen build. |
| `worker/wrangler.toml` | Kjøreplanen. |
| `status.json` | Nåtilstand. Skrives av hver kjøring. |
| `history.json` | 90 dager, én rad per dag, med hendelser. |
| `index.html` | Siden. Statisk, leser de to filene. |

Vakten skriver begge filene i **én** commit via Git Data API-et, så
historikken leser som én sjekk per commit. Tree-endepunktet tar innholdet som
ren UTF-8, så Workeren slipper å base64-kode — den eneste operasjonen som
ville kostet nevneverdig av de 10 millisekundene CPU gratisnivået gir.

Historikken er gratis: hver sjekk er en commit med tidsstempel. Det er mer
sporbart enn de fleste betalte statussider gir.

## Oppsett

### Vakten

```
cd worker
npx wrangler deploy
npx wrangler secret put INTERNAL_RPC_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TRIGGER_SECRET
```

| Secret | Hva |
|---|---|
| `INTERNAL_RPC_SECRET` | Samme verdi som i Vercel. Bearer mot helse-endepunktene. |
| `GITHUB_TOKEN` | Fine-grained PAT med **meetmax-no** som resource owner. **Contents: Read and write, kun på dette repoet.** Ingenting mer. Se advarselen under. |
| `TELEGRAM_BOT_TOKEN` | Samme bot som resten av varslingen. |
| `TELEGRAM_CHAT_ID` | Samme chat. |
| `TRIGGER_SECRET` | Beskytter manuell kjøring. Egen verdi — ruten skriver til repoet. |

Manuell kjøring, som erstatter «Run workflow»-knappen:

```
curl -H "authorization: Bearer $TRIGGER_SECRET" https://kodo-vakt.<konto>.workers.dev
```

Den er bedre enn knappen var: den beviser at det er *Workeren* som virker.

### ⚠️ PAT-en utløper — og det er dekket

Fine-grained tokens har alltid en utløpsdato. Går den ut, kan vakten fortsatt
sjekke podene, men ikke skrive resultatet hit. Uten mottiltak ville
statussiden frosset på siste gode sjekk og stått **grønn i evighet** — «alt i
orden mens en kunde er nede», som er verre enn ingen side.

To ting fanger det:

- **Workeren varsler på Telegram** når skrivingen feiler, én gang i timen.
  Den kan ikke huske at den har varslet — tilstanden ligger i repoet den ikke
  fikk skrevet til — så den sender bare i det første fem-minutters-vinduet av
  hver time. En død vakt haster i timer, ikke i minutter.
- **Siden nekter å stå grønn på gamle tall.** Er siste sjekk eldre enn 16
  minutter (tre tapte kjøringer), bytter den til «Ukjent — ingen fersk sjekk»
  og forklarer over statuslinjene at tallene under er utdaterte.

Sett en påminnelse før utløpsdatoen. Varslene er et sikkerhetsnett, ikke en
plan.

### Siden

**Settings → Pages** → kilde `main` / rot.

For `status.kodovault.no`: én CNAME hos webhuset → `meetmax-no.github.io`.
GitHub utsteder sertifikatet selv, uavhengig av Vercel.

---

Se `D-149` i `memory/DECISIONS.md` i hovedrepoet for hele begrunnelsen.
