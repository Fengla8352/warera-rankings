// Proxies WarEra's country.getAllCountries so the API key stays on the server.
// Responses are cached at Netlify's edge for 10 seconds, so any number of
// visitors share one upstream request per 10 s and stay inside the rate limit.
const UPSTREAM = "https://api2.warera.io/trpc/country.getAllCountries";

exports.handler = async () => {
  const key = process.env.WARERA_API_KEY;
  try {
    const res = await fetch(UPSTREAM, {
      headers: key ? { "X-API-Key": key } : {},
    });
    const body = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Upstream request failed", detail: String(err) }),
    };
  }
};
