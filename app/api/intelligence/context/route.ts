import { z } from 'zod';
import { boundedText, loadContexts, tileKey } from '@/lib/server/osm-context';
export const dynamic='force-dynamic';
export const maxDuration=60;
const schema=z.object({points:z.array(z.object({id:z.string().min(1).max(250),latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180)})).min(1).max(200)});
export async function POST(request:Request) {
  try {
    const {points}=schema.parse(JSON.parse(await boundedText(new Response(request.body),64000)));
    if(new Set(points.map(tileKey)).size>8)return Response.json({message:'At most eight spatial tiles per batch.'},{status:400});
    return Response.json({contexts:await loadContexts(points)},{headers:{'Cache-Control':'no-store'}});
  } catch {return Response.json({message:'Provide up to 200 valid locations in eight spatial tiles.'},{status:400});}
}
