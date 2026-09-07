import { readFeed, type FeedConfig } from "@/lib/server/observation-feed";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const hours = Number(params.get("hours") ?? "24"), limit = Number(params.get("limit") ?? "1000"), offset = Number(params.get("offset") ?? "0");
  if (![24,168].includes(hours) || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0 || offset > 1000) return Response.json({message:"Use a 24-hour or 7-day window, limit 1–1000, and offset 0–1000."},{status:400});
  const config: FeedConfig = {};
  for (const key of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","THERMOWATCH_API_URL","THERMOWATCH_API_TOKEN"] as const) config[key] = process.env[key];
  try {
    return Response.json(await readFeed(config,{hours,limit,offset}),{headers:{"Cache-Control":"no-store"}});
  } catch {
    return Response.json({message:"NASA’s observation feed is temporarily unavailable. Please retry; any previously loaded observations remain visible."},{status:502,headers:{"Cache-Control":"no-store"}});
  }
}
