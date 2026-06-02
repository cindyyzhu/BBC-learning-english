export default async function handler(req, res) {
  const { url } = req.query;
  if (!url || !url.startsWith("https://www.bbc.co.uk/")) {
    return res.status(400).json({ error: "Invalid URL" });
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const text = await response.text();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(text);
}