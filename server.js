const express = require('express');
const dotenv = require('dotenv');
const LtiProvider = require('ltijs').Provider;
const axios = require('axios');

dotenv.config();

const {
  PORT = 3001, 
  LTI_ENCRYPTION_KEY,
  MONGO_URL,
  PLATFORM_URL,
  CLIENT_ID,
  CANVAS_TOKEN 
} = process.env;

const lti = LtiProvider;

lti.setup(
  LTI_ENCRYPTION_KEY,
  { url: MONGO_URL },
  {
    appRoute: '/lti',
    loginRoute: '/login',
    keysetRoute: '/keys',
    devMode: true,
    cookies: { secure: true, sameSite: 'None' }
  }
);

lti.whitelist('/', '/api/get-groups');

// --- DETECCIÓN LTI ---
lti.onConnect(async (token, req, res) => {
  const { platformContext } = token;
  const custom = platformContext.custom || {};
  
  const courseId = custom.canvas_course_id || platformContext.context.id;
  const userId = custom.canvas_user_id || token.user; 
  const sisId = custom.canvas_user_sis_id || 'Sin SIS'; 
  
  const roles = platformContext.roles || [];
  const isTeacher = roles.some(role => role.includes('Instructor') || role.includes('Administrator'));
  const userRole = isTeacher ? 'teacher' : 'student';

  return res.redirect(`/?course_id=${courseId}&role=${userRole}&user_id=${userId}&sis_id=${sisId}`);
});

const web = express();
web.use(express.urlencoded({ extended: true }));
web.use(express.json());
web.set('view engine', 'ejs');
web.use(express.static('public'));

// --- RUTA PRINCIPAL ---
web.get('/', async (req, res) => {
  const { course_id, role, user_id, sis_id } = req.query;
  
  if (!course_id || course_id === 'undefined') return res.send("Error: Falta el ID del curso.");

  const validUserId = (user_id && user_id !== 'undefined' && user_id.trim() !== '') ? user_id : null;

  let userNameToDisplay = 'Desconocido';
  let submissionsMap = {};
  let userGroupsMap = {};
  
  let teacherStats = {}; 
  let totalStudentsCount = 0;

  try {
      if (validUserId) {
          try {
              const userRes = await axios.get(`${PLATFORM_URL}/api/v1/users/${validUserId}`, {
                  headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
              });
              userNameToDisplay = userRes.data.name || userRes.data.short_name || 'Sin nombre';
          } catch (e) {
              console.error("Aviso: No se pudo cargar el nombre:", e.message);
          }
      } else {
          userNameToDisplay = role === 'teacher' ? 'Vista de Maestro' : 'Falta ID en URL';
      }

      // 2. OBTENER TAREAS DEL CURSO (Filtro anti-exámenes)
      const assigRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/assignments?per_page=100`, {
          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
      });
      const assignments = assigRes.data.filter(a => !/examen|parcial/i.test(a.name));

      // 3. OBTENER MÓDULOS
      const modRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/modules?include[]=items&per_page=100`, {
          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
      });
      const moduleMap = {}; 
      modRes.data.forEach(mod => {
          if (mod.items) {
              mod.items.forEach(item => {
                  if (item.content_id) moduleMap[item.content_id] = mod.name;
              });
          }
      });

      // 4. LÓGICA DIVIDIDA POR ROL
      if (role === 'teacher') {
          try {
              const studentsRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/users?enrollment_type[]=student&per_page=100`, {
                  headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
              });
              totalStudentsCount = studentsRes.data.length;

              const allSubsRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/students/submissions?student_ids[]=all&per_page=100`, {
                  headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
              });

              allSubsRes.data.forEach(sub => {
                  if (!teacherStats[sub.assignment_id]) {
                      teacherStats[sub.assignment_id] = { entregadas: 0, revisadas: 0 };
                  }
                  if (sub.workflow_state === 'submitted' || sub.workflow_state === 'graded' || sub.submitted_at) {
                      teacherStats[sub.assignment_id].entregadas++;
                  }
                  if (sub.workflow_state === 'graded' || sub.graded_at) {
                      teacherStats[sub.assignment_id].revisadas++;
                  }
              });
          } catch (e) {
              console.error("❌ Error API Maestro (Alumnos/Entregas):", e.message);
          }

      } else if (validUserId) {
          try {
              const subRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/students/submissions?student_ids[]=${validUserId}&per_page=100`, {
                  headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
              });
              subRes.data.forEach(sub => { submissionsMap[sub.assignment_id] = sub; });
          } catch (e) {}

          try {
              const courseGroupsRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/groups?per_page=100`, {
                  headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
              });
              
              await Promise.all(courseGroupsRes.data.map(async (g) => {
                  try {
                      // AQUÍ PEDIMOS LOS CORREOS (include[]=email)
                      const membersRes = await axios.get(`${PLATFORM_URL}/api/v1/groups/${g.id}/users?include[]=email&per_page=100`, {
                          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
                      });
                      
                      const isMember = membersRes.data.some(u => u.id == validUserId);
                      if (isMember && g.group_category_id) {
                          // Extraemos nombres y correos
                          const memberDetails = membersRes.data.map(m => ({
                              name: m.name || m.short_name,
                              email: m.email || m.login_id || ''
                          }));

                          userGroupsMap[g.group_category_id] = { 
                              name: g.name, 
                              id: g.id,
                              members: memberDetails
                          };
                      }
                  } catch (errMember) {}
              }));
          } catch (e) { console.error("❌ Error API Grupos Alumno:", e.message); }
      }

      // 5. ARMAR TABLA FINAL
      const tableData = assignments.map(a => {
          const formatDate = (dateStr) => {
              if (!dateStr) return "-";
              const d = new Date(dateStr);
              return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute:'2-digit' });
          };

          const isGroup = a.group_category_id !== null;
          
          let row = {
              id: a.id,
              name: a.name,
              url: a.html_url,
              module_name: moduleMap[a.id] || "Sin módulo",
              available_from: formatDate(a.unlock_at),
              due_date: formatDate(a.due_at),
              is_group: isGroup,
              modalidad: isGroup ? "Equipos" : "Individual"
          };

          if (role === 'teacher') {
              const stats = teacherStats[a.id] || { entregadas: 0, revisadas: 0 };
              row.entregas = `${stats.entregadas}/${totalStudentsCount}`;
              row.revisadas = stats.revisadas;
              row.speedgrader_url = `${PLATFORM_URL}/courses/${course_id}/gradebook/speed_grader?assignment_id=${a.id}`;
          } else {
              let estatus = "No entregada";
              if (submissionsMap[a.id]) {
                  const sub = submissionsMap[a.id];
                  if (sub.graded_at || sub.workflow_state === 'graded') estatus = "Calificada";
                  else if (sub.submitted_at || sub.workflow_state === 'submitted') estatus = "Entregada";
              }
              
              let myGroupName = "Aún no tienes equipo";
              let myGroupId = null;
              let myGroupMembers = [];

              if (isGroup && userGroupsMap[a.group_category_id]) {
                  myGroupName = userGroupsMap[a.group_category_id].name;
                  myGroupId = userGroupsMap[a.group_category_id].id;
                  myGroupMembers = userGroupsMap[a.group_category_id].members;
              }

              row.group_name = myGroupName;
              row.group_id = myGroupId;
              row.group_members = myGroupMembers; 
              row.status = estatus;
          }

          return row;
      });

      res.render('index', { 
          tableData, 
          role, 
          user_id: validUserId || 'NO_APLICA', 
          userNameToDisplay, 
          platform_url: PLATFORM_URL 
      });

  } catch (error) {
      console.error("❌ ERROR GENERAL:", error.message);
      res.status(500).send("Error cargando los datos. Revisa la consola.");
  }
});

(async () => {
  await lti.deploy({ serverless: true, silent: false });
  await lti.registerPlatform({
    url: PLATFORM_URL,
    name: 'Actividades y grupos',
    clientId: CLIENT_ID,
    authenticationEndpoint: `${PLATFORM_URL}/api/lti/authorize_redirect`,
    accesstokenEndpoint: `${PLATFORM_URL}/login/oauth2/token`,
    authConfig: { method: 'JWK_SET', key: `${PLATFORM_URL}/api/lti/security/jwks` }
  });
  const host = express();
  host.enable('trust proxy');
  host.use('/', lti.app);
  host.use('/', web);
  host.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
})();