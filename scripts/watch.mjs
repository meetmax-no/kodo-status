/**
 * Ko | Do · Vault — D-149 (2026-09-09) — vakten
 *
 * Kjører i GitHub Actions hvert 5. minutt. Spør helse-endepunktene, fører
 * strike-reglene, skriver `status.json` + `history.json`, og varsler på
 * Telegram — kun på overgang.
 *
 * ─── Hvorfor den bor her og ikke på Vercel ───────────────────────────
 * En vakt som deler skjebne med det den vokter, er stille akkurat når det
 * gjelder. Det som faktisk ryker er ikke Vercels edge, men VÅRT oppsett på
 * Vercel: en feilet deploy, et alias som peker feil, en pinnet tilbakerulling.
 * Vakten står derfor helt utenfor.
 *
 * ─── Hva den bevisst IKKE ser ────────────────────────────────────────
 * Kundepodene, én for én. Repoet er offentlig, og en liste over hvem som er
 * kunde hører ikke hjemme her. Vakten ser admin og demo; sertifikatsveipet
 * på admin ser resten, og det svaret blir i Telegram og morgenrapporten.
 * Statussiden må si dette rett ut — se `index.html`.
 *
 * Ingen avhengigheter. Node 20+ på ubuntu-latest, ferdig installert.
 */
import { readFile, writeFile } from "node:fs/promises";

/**
 * demo, ikke mike. demo er nivå 2 — samme sperre og samme oppsett som ekte
 * kunder. mike er nivå 1 og ligger foran; den speiler ikke kundens virkelighet.
 *
 * Admin spørres på `/api/admin/health` fordi databasen admin er avhengig av er
 * det sentrale registeret, og den sjekken bor i admin-bucket-et (D-071).
 */
const TARGETS = [
  {
    key: "admin",
    label: "Administrasjon",
    detail: "Innlogging, provisjonering og fakturering",
    url: "https://admin.kodovault.no/api/admin/health",
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

const STATUS_FILE = "status.json";
const HISTORY_FILE = "history.json";

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.url, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
      cache: "no-store",
    });
    const ms = Date.now() - started;
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* tomt eller ikke-JSON — statuskoden er fortsatt svaret */
    }
    if (res.status === 200 && body?.ok === true) {
      return { ok: true, ms, reason: null };
    }
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
      reason: e.name === "AbortError" ? `tidsavbrudd etter ${TIMEOUT_MS} ms` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.log("[vakt] Telegram ikke konfigurert — hopper over varsel");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) console.error(`[vakt] Telegram ${res.status}: ${await res.text()}`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const bearer = process.env.INTERNAL_RPC_SECRET;
  if (!bearer) {
    console.error("[vakt] INTERNAL_RPC_SECRET mangler — kan ikke sjekke noe.");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const prev = await readJson(STATUS_FILE, { targets: {} });
  const history = await readJson(HISTORY_FILE, []);

  const alerts = [];
  const targets = {};

  for (const t of TARGETS) {
    const before = prev.targets?.[t.key] ?? {
      state: "up",
      misses: 0,
      since: now,
      lastOk: null,
      incidentFrom: null,
    };
    const result = await probe(t, bearer);

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
        closeIncident(history, t, before.incidentFrom, now);
        incidentFrom = null;
      }
    } else {
      misses += 1;
      // Oransje varsler ikke. Ellers vekkes du av nettverkshikke, skrur av
      // lyden, og er stille når det gjelder.
      state = misses === 1 ? "degraded" : "down";
      if (state === "down" && before.state !== "down") {
        // Rødt varsler på OVERGANG, ikke per sjekk. Seks timers nedetid med
        // fem minutters intervall er 72 mislykkede sjekker; du skal ha én
        // melding når det blir rødt og én når det er tilbake.
        incidentFrom = before.incidentFrom ?? now;
        alerts.push(
          `🚨 <b>${t.label} er nede</b>\n${t.detail}\n${result.reason ?? "ukjent"}\n\nTo sjekker på rad har feilet.`,
        );
        openIncident(history, t, incidentFrom, result.reason);
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

  recordDay(history, targets);

  const worst = Object.values(targets).some((t) => t.state === "down")
    ? "down"
    : Object.values(targets).some((t) => t.state === "degraded")
      ? "degraded"
      : "up";

  await writeFile(
    STATUS_FILE,
    JSON.stringify({ generatedAt: now, overall: worst, targets }, null, 2) + "\n",
  );
  await writeFile(
    HISTORY_FILE,
    JSON.stringify(history.slice(0, HISTORY_DAYS), null, 2) + "\n",
  );

  for (const a of alerts) await telegram(a);

  console.log(
    `[vakt] ${now} — samlet: ${worst}; ` +
      Object.entries(targets)
        .map(([k, v]) => `${k}=${v.state}`)
        .join(", "),
  );
}

/** Dagens rad, nyest først. Oransje som aldri ble rød lagres likevel — «tre
 *  oransje denne uka, alltid 04:00» er et mønster, ikke støy. */
function recordDay(history, targets) {
  const date = today();
  let day = history.find((d) => d.date === date);
  if (!day) {
    day = { date, checks: 0, degraded: 0, down: 0, incidents: [] };
    history.unshift(day);
  }
  day.checks += 1;
  if (Object.values(targets).some((t) => t.state === "down")) day.down += 1;
  else if (Object.values(targets).some((t) => t.state === "degraded")) day.degraded += 1;
}

function openIncident(history, target, from, reason) {
  const date = today();
  let day = history.find((d) => d.date === date);
  if (!day) {
    day = { date, checks: 0, degraded: 0, down: 0, incidents: [] };
    history.unshift(day);
  }
  day.incidents.push({
    target: target.key,
    label: target.label,
    from,
    to: null,
    reason: reason ?? null,
  });
}

/** Hendelsen kan ha startet i går. Vi leter bakover, ikke bare i dag. */
function closeIncident(history, target, from, to) {
  for (const day of history) {
    const open = day.incidents?.find((i) => i.target === target.key && i.to === null);
    if (open) {
      open.to = to;
      if (from) open.from = from;
      return;
    }
  }
}

main().catch((e) => {
  console.error("[vakt] uventet feil:", e);
  process.exit(1);
});
