// Edge Function: ask (v2 - tunable similarity threshold + score logging)
// Question -> voyage-4 query embedding -> pgvector search (match_folders, RLS applies)
// -> Claude answers grounded ONLY in retrieved folders -> answer + which folders were used.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-5";
// Tunable via Edge Function secret SIM_THRESHOLD (no redeploy needed).
// Default 0 = permissive/off. Set from real score data once ~30-50 folders exist.
const SIM_THRESHOLD = Number(Deno.env.get("SIM_THRESHOLD") ?? "0") || 0;
const MATCH_COUNT = Number(Deno.env.get("MATCH_COUNT") ?? "8") || 8;

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

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await supabase.auth.getUser();
    if (!userData || !userData.user) return json({ error: "Not signed in" }, 401);

    const body = await req.json();
    const question = (body.question || "").trim();
    if (!question) return json({ error: "Empty question" }, 400);

    // 1) Embed the question (query-side embedding)
    const vr = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + Deno.env.get("VOYAGE_API_KEY")!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "voyage-4",
        input: [question],
        input_type: "query",
      }),
    });
    if (!vr.ok) return json({ error: "Voyage API: " + (await vr.text()) }, 502);
    const ve = await vr.json();
    const qEmbedding = ve.data[0].embedding;

    // 2) Vector search over the user's folders (RLS: only their rows)
    const rpc = await supabase.rpc("match_folders", {
      query_embedding: qEmbedding,
      match_count: MATCH_COUNT,
    });
    if (rpc.error) return json({ error: rpc.error.message }, 500);
    const all = rpc.data ?? [];

    // Log raw cosine scores for threshold calibration (visible in function logs)
    console.log("ask_scores", JSON.stringify({
      q: question.slice(0, 100),
      threshold: SIM_THRESHOLD,
      scores: all.map((m: { title: string; similarity: number }) => ({
        t: m.title.slice(0, 50),
        s: Math.round(m.similarity * 1000) / 1000,
      })),
    }));

    const matches = all.filter(
      (m: { similarity: number }) => m.similarity >= SIM_THRESHOLD,
    );
    if (!matches.length) {
      return json({
        answer: all.length
          ? "Nothing in your memory cleared the relevance bar for this question."
          : "Your memory has no folders yet, so I have nothing to answer from.",
        folders: [],
      });
    }

    // 3) Claude answers grounded ONLY in the retrieved folders
    const context = matches.map(
      (m: { id: string; title: string; type: string; body: string }, i: number) =>
        "[" + (i + 1) + "] " + m.title + " (" + m.type + ")\n" + m.body,
    ).join("\n\n");

    const SYSTEM = [
      "You answer questions using ONLY the numbered memory folders provided.",
      "These folders are the user's own captured knowledge - treat them as the source of truth.",
      "Rules:",
      "- Ground every claim in the folders. Reference them inline like [1], [2].",
      "- If the folders do not contain the answer, say plainly that this is not in the memory yet - do NOT answer from general knowledge.",
      "- Be concise and direct.",
    ].join("\n");

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: "Memory folders:\n\n" + context + "\n\nQuestion: " + question,
        }],
      }),
    });
    if (!ar.ok) return json({ error: "Claude API: " + (await ar.text()) }, 502);
    const am = await ar.json();
    const textBlock = (am.content || []).find((c: { type: string }) => c.type === "text");
    const answer = (textBlock && textBlock.text) || "";

    return json({
      answer,
      folders: matches.map(
        (m: { id: string; title: string; type: string; similarity: number }, i: number) => ({
          n: i + 1,
          id: m.id,
          title: m.title,
          type: m.type,
          similarity: Math.round(m.similarity * 100) / 100,
        }),
      ),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
