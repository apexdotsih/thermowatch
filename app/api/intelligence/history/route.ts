import { z } from 'zod';
import { boundedText } from '@/lib/server/osm-context';
import { loadHistory } from '@/lib/server/thermal-history';
export const dynamic='force-dynamic';
export const maxDuration=60;
const schema=z.object({points:z.array(z.object({id:z.string().min(1).max(250),latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180),detected_at:z.string().datetime(),satellite:z.string().max(32),day_night:z.enum(['D','N'])})).min(1).max(1000)});
export async function POST(request:Request) {
  let points;
  try {points=schema.parse(JSON.parse(await boundedText(new Response(request.body),512000))).points;}
  catch{return Response.json({message:'Provide up to 1,000 valid observations.'},{status:400});}
  try{return Response.json({history:await loadHistory(points)},{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({message:'Seven-day NASA history is temporarily unavailable. Persistence remains unverified.'},{status:502});}
}
