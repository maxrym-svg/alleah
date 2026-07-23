// Edge Function: submit-pins (public, deliberately dumb)
// All validation, caps, sanitization, rate limits, and revision-queuing live inside the
// submit_pins security-definer SQL function - the SOLE public-side writer. Bypassing this
// wrapper gains nothing. Deployed with --no-verify-jwt (preview pages have no session).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    let body: { task_id?: unknown; pins?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (typeof body.task_id !== "string" || !Array.isArray(body.pins)) {
      return json({ error: "expected { task_id, pins[] }" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const r = await supabase.rpc("submit_pins", { p_task_id: body.task_id, p_pins: body.pins });
    if (r.error) {
      console.log("submit_pins_reject", r.error.message.slice(0, 200));
      return json({ error: "rejected" }, 400);
    }
    console.log("submit_pins_result", JSON.stringify(r.data));
    return json(r.data);
  } catch (e) {
    console.log("submit_pins_error", String(e).slice(0, 200));
    return json({ error: "server error" }, 500);
  }
});
