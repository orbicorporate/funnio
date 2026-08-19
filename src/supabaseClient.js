import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://spdqghchvimjytycdmjk.supabase.co";
const SUPABASE_KEY = "sb_publishable_N6lr1sn04a1hOWWooaI3tQ_QCFzEk_u";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
