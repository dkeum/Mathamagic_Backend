const {createClient} = require('@supabase/supabase-js')

// console.log("Supabase URL:", process.env.SUPABASE_URL);
// console.log("Supabase Serice KEY:", process.env.SUPABASE_SERVICE_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = supabase; 