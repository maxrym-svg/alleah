// Edge Function: request-review (public, deliberately dumb)
// All validation - build done, preview live, dedupe, 3/day rate limit - lives
// inside the request_review security-definer SQL function, the SOLE public
// writer for review-queuing. Same pattern as submit-pins. Deployed with
// --no-verify-jwt (preview pages have no session).
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

    let body: { task_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (typeof body.task_id !== "string") {
      return json({ error: "expected { task_id }" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const r = await supabase.rpc("request_review", { p_task_id: body.task_id });
    if (r.error) {
      console.log("request_review_reject", r.error.message.slice(0, 200));
      return json({ error: "rejected" }, 400);
    }
    console.log("request_review_result", JSON.stringify(r.data));
    return json(r.data);
  } catch (e) {
    console.log("request_review_error", String(e).slice(0, 200));
    return json({ error: "server error" }, 500);
  }
});
