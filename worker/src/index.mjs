/**
 * Ko | Do · Vault — D-149 (2026-09-09) — vakten, som Cloudflare Worker
 *
 * Hvert 7. minutt: spør helse-endepunktene, før strike-reglene, skriv
 * status.json + history.json til `meetmax-no/kodo-status`, og varsel på
 * Telegram — kun på overgang.
 *
 * ─── Hvorfor den flyttet hit fra GitHub Actions ──────────────────────
 * Actions kjørte aldri på timeplan. To timer, ~24 tapte slots, null
 * kjøringer — bare de manuelle. GitHubs cron er «best effort» i deres egen
 * dokumentasjon: forsinkelser ved høy last, og «some queued jobs may be
 * dropped». Fem minutter er det korteste de tillot — og det de dropper
 * først.
 * En vakt som bare går når noen ber den, er ikke en vakt.
 *
 * Cloudflare ble valgt fordi vi allerede har databehandleravtale og TIA der.
 * Det var innvendingen mot dem i utgangspunktet, og den holdt ikke.
 *
 * ─── Og den løser noe designet ikke klarte ───────────────────────────
 * D-149 endte med ett innrømmet forbehold: med Actions sto vakten OG siden
 * hos GitHub, så en GitHub-nedetid tok begge. Nå er de tre uavhengige:
 * podene på Vercel, vakten hos Cloudflare, siden på GitHub Pages. Ingen av
 * dem kan ta de to andre.
 *
 * ─── Hva den bevisst IKKE ser ────────────────────────────────────────
 * Kundepodene, én for én. Repoet er offentlig, og en liste over hvem som er
 * kunde hører ikke hjemme der. Vakten ser admin og demo; sertifikatsveipet
 * på admin ser resten, og det svaret blir i Telegram og morgenrapporten.
 *
 * Ingen avhengigheter. Ingen build. Ren ESM.
 */

/**
 * Versjonsmerke. Koden limes inn manuelt i Cloudflare, og da er det ingenting
 * som forteller hvilken utgave som faktisk kjører. Det kostet oss en runde:
 * en gammel innliming svarte «unauthorized» mens den nye koden lå i repoet,
 * og feilsøkingen gikk på alt annet enn det. Nummeret vises nå i svaret fra
 * den manuelle kjøringen og i loggen.
 */
const VERSJON = "2026-09-10.10";

const OWNER = "meetmax-no";
const REPO = "kodo-status";
const BRANCH = "main";

const STATUS_FILE = "status.json";
const HISTORY_FILE = "history.json";

/**
 * demo, ikke mike. demo er nivå 2 — samme sperre og samme oppsett som ekte
 * kunder. mike er nivå 1 og ligger foran; den speiler ikke kundens virkelighet.
 *
 * Admin spørres på `/api/internal/health` fordi databasen admin er avhengig av
 * er det sentrale registeret. Den sjekken må ligge i et bucket med sentrale
 * creds (D-071), og av de godkjente er `internal` det som autentiserer med
 * bearer i stedet for sesjon (D-076). Første forsøk lå i `/api/admin/health`
 * og svarte «Admin-session mangler» — vakten har ingen sesjon.
 */
const TARGETS = [
  {
    key: "admin",
    label: "Administrasjon",
    detail: "Innlogging, provisjonering og fakturering",
    url: "https://admin.kodovault.no/api/internal/health",
  },
  {
    key: "demo",
    label: "Kundepod",
    detail: "Representativ kundeinstallasjon (demo)",
    url: "https://demo.kodovault.no/api/health",
  },
];

const TIMEOUT_MS = 15_000;
const HISTORY_DAYS = 90;

const GH = "https://api.github.com";

function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    // GitHub avviser kall uten User-Agent.
    "user-agent": "kodo-vakt",
  };
}

/**
 * Leses via API-et, ikke via raw.githubusercontent. Raw ligger bak CDN med
 * cache i minutter, og en vakt som leser sin egen forrige tilstand fra en
 * utdatert kopi ville mistet nettopp de overgangene den varsler på.
 */
async function readJson(env, path, fallback) {
  const res = await fetch(
    `${GH}/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: { ...ghHeaders(env), accept: "application/vnd.github.raw" } },
  );
  if (!res.ok) return fallback;
  try {
    return await res.json();
  } catch {
    return fallback;
  }
}

/**
 * Begge filene i ÉN commit, via Git Data API-et.
 *
 * To grunner. Historikken skal lese som én sjekk per commit, ikke to. Og
 * tree-endepunktet tar innholdet som ren UTF-8-streng, så vi slipper å
 * base64-kode i Workeren — det er den eneste operasjonen her som ville
 * kostet nevneverdig av de 10 millisekundene CPU gratisnivået gir oss.
 */
async function commitFiles(env, files, message) {
  const h = ghHeaders(env);

  const refRes = await fetch(`${GH}/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, { headers: h });
  if (!refRes.ok) throw new Error(`git/ref: ${refRes.status} ${await refRes.text()}`);
  const baseCommitSha = (await refRes.json()).object.sha;

  const commitRes = await fetch(`${GH}/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`, { headers: h });
  if (!commitRes.ok) throw new Error(`git/commits: ${commitRes.status}`);
  const baseTreeSha = (await commitRes.json()).tree.sha;

  const treeRes = await fetch(`${GH}/repos/${OWNER}/${REPO}/git/trees`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      })),
    }),
  });
  if (!treeRes.ok) throw new Error(`git/trees: ${treeRes.status} ${await treeRes.text()}`);
  const newTreeSha = (await treeRes.json()).sha;

  const newCommitRes = await fetch(`${GH}/repos/${OWNER}/${REPO}/git/commits`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      message,
      tree: newTreeSha,
      parents: [baseCommitSha],
      author: { name: "kodo-vakt", email: "vakt@kodovault.no", date: new Date().toISOString() },
    }),
  });
  if (!newCommitRes.ok) throw new Error(`git/commits POST: ${newCommitRes.status}`);
  const newCommitSha = (await newCommitRes.json()).sha;

  // Uten force: skjøt en annen kjøring inn imellom, feiler denne i stedet for
  // å overskrive den. Vi taper ett målepunkt og tar det igjen ved neste kjøring
  // — langt bedre enn to vakter som skriver over hverandres overganger.
  const patchRes = await fetch(`${GH}/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify({ sha: newCommitSha, force: false }),
  });
  if (!patchRes.ok) throw new Error(`git/refs PATCH: ${patchRes.status} ${await patchRes.text()}`);
}

/**
 * Ett kall mot ett endepunkt. 200 + `ok: true` er friskt; alt annet er ikke.
 *
 * Vi stoler på statuskoden, men leser kroppen når den finnes: en pod kan
 * svare 503 med `checks.database = "fail"`, og da vil vi ha den grunnen med
 * inn i historikken i stedet for bare «nede».
 */
async function probe(target, bearer) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
    const ms = Date.now() - started;
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* tomt eller ikke-JSON — statuskoden er fortsatt svaret */
    }
    if (res.status === 200 && body?.ok === true) return { ok: true, ms, reason: null };
    const why =
      body?.detail ??
      (body?.checks
        ? Object.entries(body.checks)
            .filter(([, v]) => v === "fail")
            .map(([k]) => k)
            .join(", ") || `HTTP ${res.status}`
        : `HTTP ${res.status}`);
    return { ok: false, ms, reason: String(why).slice(0, 200) };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      reason: e.name === "TimeoutError" ? `tidsavbrudd etter ${TIMEOUT_MS} ms` : e.message,
    };
  }
}

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("[vakt] Telegram ikke konfigurert — hopper over varsel");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) console.error(`[vakt] Telegram ${res.status}: ${await res.text()}`);
}

/**
 * Dagens dato i NORSK tid, ikke UTC.
 *
 * `toISOString()` gir UTC-datoen, så døgnet skiftet 02:00 norsk sommertid.
 * Søylene på statussiden rullet da over midt på natten, og morgenrapportens
 * «natten» begynte klokka to. Ryker noe 00:30, havnet det i gårsdagens søyle.
 *
 * Mike leser siden som norske kalenderdager. Da skal den være det.
 * `Intl` med `Europe/Oslo` håndterer sommertid av seg selv — ingen offset å
 * huske å endre to ganger i året.
 */
const today = () => {
  const deler = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const hent = (type) => deler.find((d) => d.type === type).value;
  return `${hent("year")}-${hent("month")}-${hent("day")}`;
};

/**
 * Hvilken tredjedel av døgnet vi er i, norsk tid: 0 = 00–08, 1 = 08–16,
 * 2 = 16–24.
 *
 * Døgnet deles fordi én ustabil sjekk av 288 ellers maler et helt døgn
 * oransje på statussiden — 99,7 % av dagen var fin. Med bolker farges åtte
 * timer, og «alltid 04:00» blir synlig som et mønster i stedet for å drukne.
 */
function bolkIndeks() {
  const time = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Oslo",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
  );
  return Math.min(2, Math.floor(time / 8));
}

const tomBolk = () => ({ checks: 0, down: 0, degraded: 0 });

/** Dagens rad, nyest først. Oransje som aldri ble rød lagres likevel — «tre
 *  oransje denne uka, alltid 04:00» er et mønster, ikke støy. */
function dayRow(history) {
  const date = today();
  let day = history.find((d) => d.date === date);
  if (!day) {
    day = {
      date,
      checks: 0,
      degraded: 0,
      down: 0,
      bolker: [tomBolk(), tomBolk(), tomBolk()],
      incidents: [],
    };
    history.unshift(day);
  }
  // Rader skrevet før bolkene fantes har dem ikke. Vi fyller dem ikke inn
  // med gjetninger — dagen mangler oppløsningen, og siden skal si det.
  if (!day.bolker) day.bolker = [tomBolk(), tomBolk(), tomBolk()];
  return day;
}

/** Hendelsen kan ha startet i går. Vi leter bakover, ikke bare i dag. */
function closeIncident(history, key, from, to) {
  for (const day of history) {
    const open = day.incidents?.find((i) => i.target === key && i.to === null);
    if (open) {
      open.to = to;
      if (from) open.from = from;
      return;
    }
  }
}

export async function runCheck(env) {
  if (!env.INTERNAL_RPC_SECRET) throw new Error("INTERNAL_RPC_SECRET mangler");

  const now = new Date().toISOString();
  const [prev, history] = await Promise.all([
    readJson(env, STATUS_FILE, { targets: {} }),
    readJson(env, HISTORY_FILE, []),
  ]);

  const results = await Promise.all(TARGETS.map((t) => probe(t, env.INTERNAL_RPC_SECRET)));

  const alerts = [];
  const targets = {};

  for (const [i, t] of TARGETS.entries()) {
    const before = prev.targets?.[t.key] ?? {
      state: "up", misses: 0, since: now, lastOk: null, incidentFrom: null,
    };
    const result = results[i];

    let state = before.state;
    let misses = before.misses ?? 0;
    let incidentFrom = before.incidentFrom ?? null;

    if (result.ok) {
      // Én grønn sletter oransje. Krever man to, står siden gul lenge etter
      // at alt er bra — og da slutter man å se på fargen.
      misses = 0;
      state = "up";
      if (before.state === "down") {
        alerts.push(
          `✅ <b>${t.label} er tilbake</b>\n${t.detail}\nNede fra ${before.incidentFrom ?? "?"} til ${now}.`,
        );
        closeIncident(history, t.key, before.incidentFrom, now);
        incidentFrom = null;
      }
    } else {
      misses += 1;
      // Oransje varsler ikke. Ellers vekkes du av nettverkshikke, skrur av
      // lyden, og er stille når det gjelder.
      state = misses === 1 ? "degraded" : "down";
      if (state === "down" && before.state !== "down") {
        // Rødt varsler på OVERGANG, ikke per sjekk. Seks timers nedetid med
        // sju minutters intervall er 51 mislykkede sjekker; du skal ha én
        // melding når det blir rødt og én når det er tilbake.
        incidentFrom = before.incidentFrom ?? now;
        alerts.push(
          `🚨 <b>${t.label} er nede</b>\n${t.detail}\n${result.reason ?? "ukjent"}\n\nTo sjekker på rad har feilet.`,
        );
        dayRow(history).incidents.push({
          target: t.key, label: t.label, from: incidentFrom, to: null,
          reason: result.reason ?? null,
        });
      }
    }

    targets[t.key] = {
      label: t.label,
      detail: t.detail,
      state,
      misses,
      since: state === before.state ? (before.since ?? now) : now,
      lastOk: result.ok ? now : (before.lastOk ?? null),
      lastCheck: now,
      responseMs: result.ms,
      reason: result.ok ? null : result.reason,
      incidentFrom,
    };
  }

  const day = dayRow(history);
  const bolk = day.bolker[bolkIndeks()];
  day.checks += 1;
  bolk.checks += 1;
  const values = Object.values(targets);
  if (values.some((t) => t.state === "down")) {
    day.down += 1;
    bolk.down += 1;
  } else if (values.some((t) => t.state === "degraded")) {
    day.degraded += 1;
    bolk.degraded += 1;
  }

  const overall = values.some((t) => t.state === "down")
    ? "down"
    : values.some((t) => t.state === "degraded")
      ? "degraded"
      : "up";

  await commitFiles(
    env,
    {
      [STATUS_FILE]: JSON.stringify({ generatedAt: now, overall, targets }, null, 2) + "\n",
      [HISTORY_FILE]: JSON.stringify(history.slice(0, HISTORY_DAYS), null, 2) + "\n",
    },
    `vakt: ${now.slice(0, 16).replace("T", " ")} UTC`,
  );

  for (const a of alerts) await telegram(env, a);

  const summary = `${now} — samlet: ${overall}; ` +
    Object.entries(targets).map(([k, v]) => `${k}=${v.state}`).join(", ");
  console.log(`[vakt ${VERSJON}] ${summary}`);
  return { overall, targets, alerts: alerts.length, at: now };
}

/**
 * Når vakten selv er ødelagt.
 *
 * Feiler skrivingen til GitHub — utløpt PAT er den klart vanligste årsaken,
 * og fine-grained tokens utløper alltid — så fryser statussiden på siste gode
 * sjekk og står grønn i evighet. Det er «alt i orden mens en kunde er nede»,
 * som er verre enn ingen side. Den feilen skal si fra om seg selv.
 *
 * Vi kan ikke huske at vi har varslet: tilstanden vår ligger i det repoet vi
 * nettopp ikke fikk skrevet til. I stedet varsles det én gang i timen, ved å
 * bare sende i det første fem-minutters-vinduet. Grovt, men det holder — en
 * vakt som er nede haster i timer, ikke i minutter, og et varsel hvert femte
 * minutt ville uansett blitt skrudd av.
 */
async function reportSelfFailure(env, e) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error("[vakt] kjøringen feilet:", e?.stack ?? detail);
  if (new Date().getUTCMinutes() >= 5) return;
  await telegram(
    env,
    "🔌 <b>Vakten kan ikke skrive til GitHub</b>\n" +
      detail.slice(0, 300) +
      "\n\nStatussiden står nå på siste gode sjekk og blir ikke oppdatert. " +
      "Vanligste årsak: GITHUB_TOKEN er utløpt.",
  ).catch(() => {});
}

export default {
  async scheduled(event, env, ctx) {
    // FØRSTE linje, før alt annet. Vi har brukt en time på å slutte oss til
    // om cronen kjører ut fra om det dukket opp commits — altså fra enden av
    // en kjede med fem ledd. Denne linja skrives før noe kan gå galt, så den
    // svarer på det ene spørsmålet: kaller Cloudflare oss i det hele tatt?
    console.log(
      `[vakt ${VERSJON}] CRON UTLØST — planlagt ` +
        `${new Date(event.scheduledTime).toISOString()}, uttrykk "${event.cron}"`,
    );
    ctx.waitUntil(runCheck(env).catch((e) => reportSelfFailure(env, e)));
  },

  /**
   * Manuell kjøring — «sjekk nå, ikke vent på klokka».
   *
   * Hemmeligheten kan gis på to måter, og det er med vilje:
   *
   *   ?key=<TRIGGER_SECRET>          — kan limes rett i adressefeltet
   *   Authorization: Bearer <secret> — for skript og verktøy
   *
   * Nøkkel i URL havner i nettleserhistorikk og i logger, og det er en ekte
   * ulempe. Men den låser opp nøyaktig én ting: å kjøre en sjekk nå, som
   * klokka gjør hvert sjuende minutt uansett. Alternativet var en utløser bare
   * den med kommandolinje kunne bruke — altså ingen utløser for den som
   * faktisk drifter dette. Bruk en lang, tilfeldig verdi, og bytt den om den
   * kommer på avveie.
   */
  async fetch(req, env) {
    const tekst = (body, status = 200) =>
      new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

    if (!env.TRIGGER_SECRET) {
      // Skill dette fra «feil nøkkel». Uten skillet står man og gjetter på
      // hvilken av to helt ulike feil man har.
      return tekst(
        `Vakt ${VERSJON}\n\nTRIGGER_SECRET er ikke satt på denne Workeren.\n\n` +
          "Cloudflare → kodo-vakt → Settings → Variables and Secrets → + Add,\n" +
          "type Secret, navn nøyaktig TRIGGER_SECRET. Husk Deploy etterpå.\n",
        401,
      );
    }

    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";

    // `searchParams` tolker `+` som mellomrom — en tilfeldig generert nøkkel
    // med `+` i ville derfor aldri matchet. Vi leser derfor også spørringen
    // rå, og prøver begge tolkninger. Trimming fordi en verdi limt inn i
    // Cloudflares skjema lett får med seg et linjeskift.
    // Del kun på FØRSTE `=`. En nøkkel som selv inneholder `=` — base64 har
    // det ofte — ble ellers kuttet på midten. Fanget av testen, ikke av øyet.
    const rå =
      url.search
        .replace(/^\?/, "")
        .split("&")
        .map((p) => {
          const i = p.indexOf("=");
          return i === -1 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
        })
        .find(([k]) => k === "key")?.[1] ?? "";
    let råDekodet = rå;
    try {
      råDekodet = decodeURIComponent(rå);
    } catch {
      /* ugyldig %-sekvens — bruk den rå verdien */
    }

    const fasit = env.TRIGGER_SECRET.trim();
    const kandidater = [
      url.searchParams.get("key"),
      rå,
      råDekodet,
      auth.startsWith("Bearer ") ? auth.slice(7) : null,
    ];
    if (!kandidater.some((k) => typeof k === "string" && k.trim() === fasit)) {
      return tekst(
        `Vakt ${VERSJON}\n\nNøkkelen stemmer ikke.\n\n` +
          "TRIGGER_SECRET er satt på Workeren, men verdien i adressen er en\n" +
          "annen. Vanligste årsak: verdien ble limt inn med et mellomrom eller\n" +
          "linjeskift, eller den inneholder tegn som må skrives om i en URL.\n\n" +
          "Enkleste fiks: sett TRIGGER_SECRET til noe med bare bokstaver og\n" +
          "tall, deploy, og prøv igjen.\n",
        401,
      );
    }
    try {
      const out = await runCheck(env);
      // Lesbart i nettleseren, ikke bare for maskiner.
      const linjer = Object.entries(out.targets).map(
        ([k, v]) => `  ${k.padEnd(6)} ${v.state}${v.reason ? " — " + v.reason : ""}`,
      );
      return tekst(
        `Vakt ${VERSJON} — sjekk kjørt ${out.at}\n\n` +
          `Samlet: ${out.overall}\n${linjer.join("\n")}\n\n` +
          `Varsler sendt: ${out.alerts}\n\nSe status.kodovault.no om et minutt.\n`,
      );
    } catch (e) {
      return tekst(`Kjøringen feilet:\n\n${e.message}\n`, 500);
    }
  },
};
