import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "../../../lib/supabase";

// POST only (the middleware rejects cross-origin POSTs), so a link cannot sign a user out.
export async function POST(request: NextRequest) {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.nextUrl.origin), { status: 303 });
}
