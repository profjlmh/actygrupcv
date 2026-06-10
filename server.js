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

// ... dentro de lti.onConnect
lti.onConnect(async (token, req, res) => {
  const { platformContext } = token;
  const custom = platformContext.custom || {};
  
  const courseId = custom.canvas_course_id || platformContext.context.id;
  const userId = custom.canvas_user_id || token.user; 
  
  // Vamos a verificar el rol en el curso específico usando la API
  let userRole = 'student'; // Default
  try {
      const memberRes = await axios.get(`${process.env.PLATFORM_URL}/api/v1/courses/${courseId}/users/${userId}?enrollment_type[]=teacher&enrollment_type[]=ta&enrollment_type[]=student`, {
          headers: { 'Authorization': `Bearer ${process.env.CANVAS_TOKEN}` }
      });
      
      const enrollments = memberRes.data.enrollments;
      // Si el usuario tiene alguna inscripción como 'teacher' o 'ta' en este curso, es maestro
      const isTeacher = enrollments.some(e => e.type === 'TeacherEnrollment' || e.type === 'TaEnrollment');
      userRole = isTeacher ? 'teacher' : 'student';
  } catch (e) {
      console.error("Error al validar rol en curso:", e.message);
  }

  return res.redirect(`/?course_id=${courseId}&role=${userRole}&user_id=${userId}`);
});

const web = express();
web.use(express.urlencoded({ extended: true }));
web.use(express.json());
web.set('view engine', 'ejs');
web.use(express.static('public'));

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

      // 1. OBTENER MÓDULOS (Excluyendo plantillas)
      const modRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/modules?include[]=items&per_page=100`, {
          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
      });
      const moduleMap = {}; 
      const excludedModules = new Set();

      modRes.data.forEach(mod => {
          if (/plantilla|template/i.test(mod.name)) {
              excludedModules.add(mod.id);
              return;
          }
          if (mod.items) {
              mod.items.forEach(item => {
                  if (item.content_id) moduleMap[item.content_id] = mod.name;
                  if (item.type === 'Discussion' && item.page_url) {
                      moduleMap[item.page_url] = mod.name; 
                  }
              });
          }
      });

      // 2. OBTENER TAREAS Y EXÁMENES DESDE ASSIGNMENTS
      const assigRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/assignments?per_page=100`, {
          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
      });
      
      let mixedActivities = assigRes.data.filter(a => a.published !== false).map(a => {
          let tipoActividad = 'Tarea';
          if (a.submission_types && a.submission_types.includes('online_quiz') || /examen|parcial/i.test(a.name)) {
              tipoActividad = 'Examen';
          } else if (a.submission_types && a.submission_types.includes('discussion_topic')) {
              tipoActividad = 'Foro de discusión';
          }
          return { ...a, activity_type: tipoActividad };
      });

      // 3. OBTENER FOROS DE DISCUSIÓN NO CALIFICABLES
      try {
          const forumRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/discussion_topics?per_page=100`, {
              headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
          });
          const nonGradedForums = forumRes.data.filter(f => !f.assignment_id && f.published !== false).map(f => ({
              ...f,
              id: f.id,
              name: f.title,
              html_url: f.html_url,
              unlock_at: f.delayed_post_at, 
              due_at: null,
              lock_at: f.lock_at,
              group_category_id: f.group_category_id,
              activity_type: 'Foro de discusión'
          }));
          mixedActivities = mixedActivities.concat(nonGradedForums);
      } catch (e) { console.error("Aviso: No se pudieron cargar los foros adicionales"); }

      // 4. LOGICA CARGA DE ROLES
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
          } catch (e) { console.error("Error API Maestro:", e.message); }

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
                      const membersRes = await axios.get(`${PLATFORM_URL}/api/v1/groups/${g.id}/users?include[]=email&per_page=100`, {
                          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
                      });
                      const isMember = membersRes.data.some(u => u.id == validUserId);
                      if (isMember && g.group_category_id) {
                          userGroupsMap[g.group_category_id] = { 
                              name: g.name, 
                              id: g.id,
                              members: membersRes.data.map(m => ({ name: m.name || m.short_name, email: m.email || '' }))
                          };
                      }
                  } catch (errMember) {}
              }));
          } catch (e) { console.error("Error API Grupos:", e.message); }
      }

      // 5. PROCESAMIENTO AVANZADO Y CONSTRUCCIÓN DE TABLA (Soporta llamadas Async)
      let tableData = await Promise.all(mixedActivities.map(async (a) => {
          const formatDate = (dateStr) => {
              if (!dateStr) return "-";
              const d = new Date(dateStr);
              return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute:'2-digit' });
          };

          const rawDateStr = (dateStr) => dateStr ? new Date(dateStr).toISOString() : '9999-12-31T23:59:59Z';
          const isGroup = a.group_category_id !== null;
          
          let moduleName = moduleMap[a.id] || "Sin módulo";
          if (moduleName === "Sin módulo" && a.activity_type === 'Foro de discusión') {
               const urlParts = a.html_url.split('/');
               const topicUrl = urlParts[urlParts.length - 1];
               if(moduleMap[topicUrl]) moduleName = moduleMap[topicUrl];
          }

          let row = {
              id: a.id,
              name: a.name,
              url: a.html_url,
              module_name: moduleName,
              available_from: formatDate(a.unlock_at),
              due_date: formatDate(a.due_at),
              lock_date: formatDate(a.lock_at),
              raw_available: rawDateStr(a.unlock_at),
              raw_due: rawDateStr(a.due_at),
              raw_lock: rawDateStr(a.lock_at),
              is_group: isGroup,
              activity_type: a.activity_type,
              forum_indicators: [] // Guardará sub-estados de foros
          };

          if (role === 'teacher') {
              const stats = teacherStats[a.id] || { entregadas: 0, revisadas: 0 };
              row.entregas = a.activity_type === 'Foro de discusión' && !a.assignment_id ? '-' : `${stats.entregadas}/${totalStudentsCount}`;
              row.revisadas = a.activity_type === 'Foro de discusión' && !a.assignment_id ? '-' : stats.revisadas;
              row.speedgrader_url = a.activity_type === 'Foro de discusión' && !a.assignment_id ? a.html_url : `${PLATFORM_URL}/courses/${course_id}/gradebook/speed_grader?assignment_id=${a.id}`;
          } else {
              // Estatus por defecto
              let estatus = "🔴 No entregada";
              if (submissionsMap[a.id]) {
                  const sub = submissionsMap[a.id];
                  if (sub.workflow_state === 'graded' || sub.graded_at) {
                      estatus = "🟢 Calificada";
                  } else if (sub.workflow_state === 'submitted' || sub.submitted_at) {
                      estatus = sub.late ? "🟡 Entrega con atraso" : "🔵 Entregada";
                  }
              } else if (a.activity_type === 'Foro de discusión' && !a.assignment_id) {
                  estatus = "🔴 No entregada"; // Foros no obligatorios asumen no entregada si no hay posts
              }

              // --- RETO PRINCIPAL: VALIDACIÓN AVANZADA DE FOROS ---
              if (a.activity_type === 'Foro de discusión' && validUserId) {
                  try {
                      let topicId = a.discussion_topic ? a.discussion_topic.id : a.id;
                      const viewRes = await axios.get(`${PLATFORM_URL}/api/v1/courses/${course_id}/discussion_topics/${topicId}/view`, {
                          headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
                      });

                      const viewEntries = viewRes.data.view || [];
                      let hasInitialPost = false;
                      let hasFeedbackPost = false;

                      viewEntries.forEach(entry => {
                          // Entrada raíz = Aportación inicial
                          if (entry.user_id == validUserId && !entry.parent_id) {
                              hasInitialPost = true;
                          }
                          // Revisar respuestas anidadas creadas por el alumno
                          if (entry.replies) {
                              entry.replies.forEach(reply => {
                                  if (reply.user_id == validUserId) {
                                      hasFeedbackPost = true;
                                  }
                                  if (reply.replies) {
                                      reply.replies.forEach(subReply => {
                                          if (subReply.user_id == validUserId) hasFeedbackPost = true;
                                      });
                                  }
                              });
                          }
                      });

                      if (hasInitialPost) row.forum_indicators.push("Aportación inicial realizada");
                      if (hasFeedbackPost) row.forum_indicators.push("Retroalimentación realizada");
                      
                      // Si detectamos participación real pero el estado de Canvas sigue vacío (foros no calificables)
                      if ((hasInitialPost || hasFeedbackPost) && estatus === "🔴 No entregada" && !a.assignment_id) {
                          estatus = "🔵 Entregada";
                      }
                  } catch (forumErr) {
                      console.error(`No se pudo verificar detalle del foro ${topicId}:`, forumErr.message);
                  }
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
      }));

      tableData = tableData.filter(row => row.module_name !== 'Sin módulo' || !excludedModules.size);

      res.render('index', { 
          tableData, 
          role, 
          user_id: validUserId || 'NO_APLICA', 
          userNameToDisplay, 
          platform_url: PLATFORM_URL 
      });

  } catch (error) {
      console.error("❌ ERROR GENERAL:", error.message);
      res.status(500).send("Error cargando los datos.");
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
  host.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
})();