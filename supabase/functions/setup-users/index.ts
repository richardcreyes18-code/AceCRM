import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const USERS = [
  // Admins
  { name:'Ricky Reyes',      email:'richard-reyes@kw.com',                    phone:'843-926-1393', initials:'RR', fub_name:'Richard Reyes',   role:'admin',   password:'Ace!Ricky24'   },
  { name:'Henry Eisenstein', email:'henry.eisenstein@aceacq.temp',             phone:'908-216-6532', initials:'HE', fub_name:'Henry Eisenstein', role:'admin',   password:'Ace!Henry24'   },
  // Agents
  { name:'Aidan Alverson',   email:'aidan.alverson@aceacq.temp',               phone:'609-752-7435', initials:'AA', fub_name:'Aidan Alverson',   role:'agent',   password:'Ace!Aidan24'   },
  { name:'Tim Emrich',       email:'tim.emrich@aceacq.temp',                   phone:'609-414-2440', initials:'TE', fub_name:'Timothy Emrich',   role:'agent',   password:'Ace!Tim24'     },
  { name:'Joe Domenech',     email:'joe.domenech@aceacq.temp',                 phone:'609-314-4875', initials:'JD', fub_name:'Joseph Domenech',  role:'agent',   password:'Ace!JoeD24'    },
  { name:'Will Hartgers',    email:'will.hartgers@aceacq.temp',                phone:'201-625-3939', initials:'WH', fub_name:'Will Hartgers',    role:'agent',   password:'Ace!Will24'    },
  { name:'Everett James',    email:'everett.james@aceacq.temp',                phone:'732-588-9046', initials:'EJ', fub_name:'Everett James',    role:'agent',   password:'Ace!Everett24' },
  { name:'Greg Sly',         email:'greg.sly@aceacq.temp',                     phone:'908-499-9759', initials:'GS', fub_name:'Greg Sly',         role:'agent',   password:'Ace!Greg24'    },
  { name:'Joe Spinella',     email:'joe.spinella@aceacq.temp',                 phone:'732-546-7501', initials:'JS', fub_name:'Joseph Spinella',  role:'agent',   password:'Ace!JoeS24'    },
  { name:'Dan Keenan',       email:'dan.keenan@aceacq.temp',                   phone:'908-670-6691', initials:'DK', fub_name:'Daniel Keenan',    role:'agent',   password:'Ace!Dan24'     },
  { name:'Skyler Nussbeck',  email:'skyler.nussbeck@aceacq.temp',              phone:'816-398-5053', initials:'SN', fub_name:'Skyler Nussbeck',  role:'agent',   password:'Ace!Skyler24'  },
  // Trainees
  { name:'Farrah Nisivoccia',email:'farrah.nisivoccia@aceacq.temp',            phone:'973-220-0656', initials:'FN', fub_name:'Farrah Nisivoccia',role:'trainee', password:'Ace!Farrah24'  },
  { name:'Thomas Ventrone',  email:'thomas.ventrone@aceacq.temp',              phone:'732-616-3302', initials:'TV', fub_name:'Thomas Ventrone',  role:'trainee', password:'Ace!Thomas24'  },
  { name:'Louis Ferrara',    email:'louis.ferrara@aceacq.temp',                phone:'908-892-9566', initials:'LF', fub_name:'Louis Ferrara',    role:'trainee', password:'Ace!Louis24'   },
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const results = []

  for (const user of USERS) {
    try {
      // Create auth user
      const { data: authData, error: authErr } = await sb.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
        user_metadata: { name: user.name, initials: user.initials, role: user.role }
      })

      if (authErr) {
        // User might already exist — try to get them
        const { data: { users } } = await sb.auth.admin.listUsers()
        const existing = users.find(u => u.email === user.email)
        if (existing) {
          // Update their profile
          await sb.from('ace_users').upsert({
            id: existing.id,
            name: user.name, email: user.email, phone: user.phone,
            initials: user.initials, fub_name: user.fub_name, role: user.role
          })
          results.push({ name: user.name, status: 'already_exists', id: existing.id })
          continue
        }
        throw authErr
      }

      // Create profile
      const { error: profileErr } = await sb.from('ace_users').upsert({
        id: authData.user.id,
        name: user.name, email: user.email, phone: user.phone,
        initials: user.initials, fub_name: user.fub_name, role: user.role
      })

      if (profileErr) throw profileErr
      results.push({ name: user.name, status: 'created', email: user.email, password: user.password, id: authData.user.id })

    } catch (e) {
      results.push({ name: user.name, status: 'error', error: String(e) })
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
  })
})
