import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../../lib/supabaseKintote";

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL;
export const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? SUPABASE_PUBLISHABLE_KEY;
