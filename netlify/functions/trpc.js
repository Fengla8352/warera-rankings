// Read-only proxy for other WarEra tRPC procedures (regions, companies, workers…).
// Usage: /api/trpc/region.getRegionsObject   or   /api/trpc/company.getCompanies?input={"userId":"..."}
// Only whitelisted namespaces are forwarded, and the API key never leaves the server.
const ALLOWED = /^(region|company|country|worker|workOffer|government|gameConfig)\.[A-Za-z]+$/;

// The procedure name is read from the requested path (/api/trpc/<name>), with ?proc= as a fallback.
function getProc(event) {
  const m = /\/api\/trpc\/([^/?#]+)/.exec(event.rawUrl || event.path || "");
  if (m) return decodeURIComponent(m[1]);
  return (event.queryStringParameters || {}).proc || "";
}

exports.handler = async (event) => {
  const proc = getProc(event);
  const input = (event.queryStringParameters || {}).input;
  if (!ALLOWED.test(proc)) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Procedure not allowed" }) };
  }
  const url = "https://api2.warera.io/trpc/" + proc + (input ? "?input=" + encodeURIComponent(input) : "");
  const key = process.env.WARERA_API_KEY;
  try {
    const res = await fetch(url, { headers: key ? { "X-API-Key": key } : {} });
    const body = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      },
      body,
    };
  } catch (err) {
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Upstream request failed", detail: String(err) }) };
  }
};
