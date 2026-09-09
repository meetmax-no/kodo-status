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

## Hva vakten ser — og ikke ser

| Sjekkes | Hvordan |
|---|---|
| Administrasjon | `admin.kodovault.no/api/admin/health` hvert 5. min |
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
| `scripts/watch.mjs` | Vakten. Ingen avhengigheter. |
| `.github/workflows/watch.yml` | Kjøreplanen. |
| `status.json` | Nåtilstand. Skrives av hver kjøring. |
| `history.json` | 90 dager, én rad per dag, med hendelser. |
| `index.html` | Siden. Statisk, leser de to filene. |

Historikken er gratis: hver sjekk er en commit med tidsstempel. Det er mer
sporbart enn de fleste betalte statussider gir.

## Oppsett

Tre secrets under **Settings → Secrets and variables → Actions**:

| Secret | Hva |
|---|---|
| `INTERNAL_RPC_SECRET` | Samme verdi som i Vercel. Bearer mot helse-endepunktene. |
| `TELEGRAM_BOT_TOKEN` | Samme bot som resten av varslingen. |
| `TELEGRAM_CHAT_ID` | Samme chat. |

Og **Settings → Pages** → kilde `main` / rot.

For `status.kodovault.no`: én CNAME hos webhuset → `meetmax-no.github.io`.
GitHub utsteder sertifikatet selv, uavhengig av Vercel.

---

Se `D-149` i `memory/DECISIONS.md` i hovedrepoet for hele begrunnelsen.
