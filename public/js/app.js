// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyD5FFDHe2mAtqfBBw6vz4-V2WflvTxCTEw",
  authDomain: "vida-finance.firebaseapp.com",
  projectId: "vida-finance",
  storageBucket: "vida-finance.firebasestorage.app",
  messagingSenderId: "447766605132",
  appId: "1:447766605132:web:7d747366eb91b2452cb3e9",
  measurementId: "G-MLCEK7E9JM"
};

firebase.initializeApp(firebaseConfig);
const appCheck = firebase.appCheck();
appCheck.activate('6LcROIksAAAAAKv4V9UtRXdalbYNGzOK23tE-WX5', true);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

// ─── i18n ────────────────────────────────────────────────
const i18n = {
  es: {
    nav_employers:'Empleadores',nav_employees:'Empleados',nav_trust:'Confianza',nav_how:'Cómo funciona',nav_login:'Iniciar sesión',nav_get_started:'Comenzar',nav_partners:'Socios',nav_investors:'Inversionistas',nav_contact:'Contacto',lang_toggle:'EN',
    hero_badge:'Crédito respaldado por tu empleador',hero_h1:'Tu respaldo<br><em>financiero</em><br>integrado.',hero_sub:'Liquidez de emergencia a través de la nómina de tu empleador. Pre-aprobado. Instantáneo.',hero_cta_employer:'Soy Empleador',hero_cta_employee:'Soy Empleado',
    phone_available:'Crédito Disponible',phone_active:'Activo',phone_currency:'Pesos Mexicanos · Vía nómina',phone_repayment:'Plazo',phone_repayment_val:'30 días',phone_disbursement:'Desembolso',phone_disbursement_val:'En 24 hrs',phone_deduction:'Deducción',phone_deduction_val:'Nómina automática',phone_utilization:'Utilización',phone_request:'Solicitar Fondos',
    chip_24hrs:'24 hrs',chip_disbursement:'Desembolso',chip_0fees:'$0 comisiones',chip_transparent:'Transparente',chip_encrypted:'Encriptado',chip_bankgrade:'Grado bancario',
    ben_fees:'Comisiones ocultas',ben_disbursement:'Desembolso',ben_encrypted:'Encriptado',ben_governance:'Gobernanza',
    stmt_h2:'La vida es<br><em>impredecible.</em>',stmt_p:'VIDA es tu red de seguridad respaldada por tu empleador para cuando más lo necesitas.',
    emo_1_title:'Gastos inesperados',emo_1_desc:'Cuentas que llegan sin aviso',emo_2_title:'Emergencias médicas',emo_2_desc:'Visitas al hospital o recetas urgentes',emo_3_title:'Necesidades familiares',emo_3_desc:'Apoyar a tus seres queridos en momentos difíciles',emo_4_title:'Reparaciones',emo_4_desc:'Auto, hogar o electrodomésticos averiados',
    hiw_tag:'Cómo funciona',hiw_h2:'Accede a crédito de emergencia, ya habilitado por tu empresa.',hiw_p:'Cuatro pasos. Sin papeleo. Sin verificación crediticia.',step_1_title:'El empleador se integra',step_1_desc:'Tu empresa conecta VIDA a la nómina — sin carga operativa.',step_2_title:'Estás pre-aprobado',step_2_desc:'Una línea de crédito estructurada de hasta $5,000 MXN. Sin verificaciones.',step_3_title:'Solicita fondos',step_3_desc:'Recibe fondos en 24 horas. Plazo de 30 días con deducción automática.',step_4_title:'Deducción automática',step_4_desc:'Los pagos se deducen de la nómina. Sin pagos manuales.',
    calc_tag:'Simula',calc_h2:'Descubre cuánto<br>puedes acceder.',calc_p:'Calcula tu línea de crédito en segundos. Ajusta tu salario y monto deseado.',calc_salary:'Salario mensual',calc_salary_placeholder:'Ingresa tu salario',calc_credit:'Crédito deseado',calc_term:'Plazo de pago',calc_days:'días',calc_rate:'30% mensual',calc_result_label:'Pago estimado',calc_note:'Fondos disponibles en 24 horas',calc_cta:'Solicitar Acceso',
    emp_tag:'Para Empleadores',emp_h2:'Ofrece estabilidad financiera sin carga.',emp_p:'Cero responsabilidad. Integración simple. Impacto medible en retención.',emp_link:'Explorar Beneficios para Empleadores',emp_retention:'Tasa de retención',emp_liability:'Responsabilidad del empleador',emp_liability_c:'Cero riesgo',emp_integration:'Integración',emp_integration_c:'API de nómina',emp_adoption:'Tasa de adopción',
    scn_tag:'Para Empleados',scn_h2:'Apoyo cuando más lo necesitas.',scn_p:'Sin verificación crediticia. Pre-aprobado. Transparente.',scn_1_title:'Emergencia médica',scn_1_desc:'Visita al hospital o receta urgente',scn_2_title:'Reparación de auto',scn_2_desc:'Vehículo del que dependes para trabajar',scn_3_title:'Emergencia del hogar',scn_3_desc:'Plomería, electricidad, electrodomésticos',scn_4_title:'Apoyo familiar',scn_4_desc:'Ayuda en un momento difícil',
    trust_tag:'Confianza',trust_h2:'Construido sobre gobernanza institucional.',trust_p:'Regulado, encriptado, transparente.',trust_1_title:'Gobernanza Suiza',trust_1_desc:'Holding bajo regulación financiera suiza',trust_2_title:'Registrada en SOFOM',trust_2_desc:'Licenciada y regulada en México',trust_3_title:'Encriptación Bancaria',trust_3_desc:'Tus datos protegidos en cada capa',trust_4_title:'Precios Transparentes',trust_4_desc:'Sin comisiones ocultas, estructura de costos clara',trust_link:'Ver Cumplimiento',
    close_h2:'Vida financiera. <em>Reinventada.</em>',close_sub:'Únete a cientos de empleadores construyendo resiliencia financiera.',close_cta:'Comenzar',
    ft_tagline:'Crédito de emergencia habilitado por el empleador. Gobernanza suiza. Operación en México.',ft_platform:'Plataforma',ft_company:'Empresa',ft_about:'Acerca de',ft_security:'Seguridad',ft_privacy:'Privacidad',ft_terms:'Términos',ft_connect:'Conecta',ft_press:'Prensa',ft_privacy_policy:'Política de Privacidad',ft_terms_service:'Términos de Servicio',
    auth_welcome:'Bienvenido de nuevo',auth_signin_sub:'Inicia sesión en tu cuenta',auth_email:'Correo electrónico',auth_email_placeholder:'tu@empresa.com',auth_password:'Contraseña',auth_password_placeholder:'Tu contraseña',auth_signin_btn:'Iniciar Sesión',auth_signing_in:'Iniciando sesión...',auth_no_account:'¿No tienes cuenta?',auth_signup_link:'Regístrate',auth_has_account:'¿Ya tienes cuenta?',auth_login_link:'Iniciar sesión',auth_invalid_code:'Código de empleador inválido. Consulta con tu departamento de RH.',
    dash_dashboard:'Panel',dash_employees:'Empleados',dash_loans:'Préstamos',dash_signout:'Cerrar sesión',dash_employer_code:'Código de Empleador',dash_total_employees:'Total Empleados',dash_active_loans:'Préstamos Activos',dash_pending_requests:'Solicitudes Pendientes',dash_total_disbursed:'Total Desembolsado',dash_recent_loans:'Solicitudes de Préstamo Recientes',dash_th_employee:'Empleado',dash_th_amount:'Monto',dash_th_term:'Plazo',dash_th_status:'Estado',dash_th_docs:'Documentos',dash_th_action:'Acción',dash_approve:'Aprobar',dash_reject:'Rechazar',dash_no_loans_employer:'Aún no hay solicitudes. Comparte tu código de empleador',dash_no_loans_employer_2:'con tus empleados.',dash_days:'días',dash_doc_contract:'Contrato',dash_doc_receipt:'Recibo',dash_doc_generating:'Generando...',
    dash_welcome:'Bienvenido',dash_available_credit:'Crédito Disponible',dash_credit_limit:'Límite de Crédito',dash_utilization:'Utilización',dash_quick_action:'Acción Rápida',dash_request_funds:'Solicitar Fondos',dash_your_loans:'Tus Préstamos',dash_my_loans:'Mis Préstamos',dash_th_repayment:'Pago',dash_th_date:'Fecha',dash_no_loans_employee:'Aún no tienes préstamos. Solicita tu primer fondo de emergencia arriba.',
    modal_request:'Solicitar Fondos',modal_available:'Disponible',modal_amount:'Monto (MXN)',modal_term:'Plazo de Pago',modal_term_30:'30 días',modal_rate:'30% mensual',modal_loan_amount:'Monto del préstamo',modal_fee:'Comisión (30%)',modal_total:'Pago total',modal_confirm:'Confirmar Solicitud',modal_submitting:'Enviando...',modal_exceed:'El monto excede el crédito disponible',modal_minimum:'El monto mínimo es $500 MXN',
    toast_loan_approved:'Préstamo aprobado',toast_loan_rejected:'Préstamo rechazado',toast_loan_submitted:'Solicitud enviada. Tu empleador recibirá la notificación.',modal_accept_terms:'Acepto los términos y condiciones',modal_due_date:'Fecha de vencimiento',
    status_pending:'pendiente',status_approved:'aprobado',status_disbursement_queued:'desembolso en cola',status_active:'activo',status_rejected:'rechazado',status_paid:'pagado',status_overdue:'vencido',
    tab_all:'Todos',tab_pending:'Pendientes',tab_approved:'Aprobados',tab_active:'Activos',tab_paid:'Completados',tab_rejected:'Rechazados',
    dash_emp_name:'Nombre',dash_emp_email:'Email',dash_emp_limit:'Límite',dash_emp_available:'Disponible',dash_emp_registered:'Registro',dash_emp_search_placeholder:'Buscar por nombre o email...',dash_no_employees:'Aún no hay empleados registrados.',

    // Employer HR Dashboard
    ehr_overview:'Resumen',ehr_employees:'Empleados',ehr_deductions:'Deducciones',ehr_onboarding:'Onboarding',ehr_analytics:'Analítica',
    ehr_total_employees:'Total Empleados',ehr_active_loans:'Préstamos Activos',ehr_total_disbursed:'Total Desembolsado',ehr_overdue_count:'Vencidos',ehr_adoption_rate:'Tasa de Adopción',ehr_outstanding:'Saldo Pendiente',
    ehr_upcoming_deductions:'Deducciones Próximas',ehr_th_employee_id:'ID Empleado',ehr_th_amount:'Monto',ehr_th_due_date:'Fecha de Vencimiento',ehr_th_loan_id:'ID Préstamo',ehr_no_deductions:'No hay deducciones próximas.',
    ehr_emp_status:'Estado',ehr_emp_active:'Activo',ehr_emp_inactive:'Inactivo',ehr_emp_credit:'Crédito Disponible',ehr_emp_loans:'Préstamos Activos',ehr_emp_search:'Buscar empleado...',ehr_emp_filter_all:'Todos',ehr_emp_filter_active:'Activos',ehr_emp_filter_inactive:'Inactivos',ehr_no_employees:'No hay empleados registrados.',
    ehr_ded_current:'Ciclo Actual',ehr_ded_history:'Historial',ehr_ded_employee:'Empleado',ehr_ded_amount:'Monto',ehr_ded_due:'Vencimiento',ehr_ded_status:'Estado',ehr_ded_loan:'Préstamo',ehr_ded_deducted:'Deducido',ehr_ded_pending:'Pendiente',ehr_ded_missed:'Faltante',ehr_ded_export:'Exportar CSV',ehr_no_deductions_hist:'No hay deducciones registradas.',ehr_ded_month:'Mes',
    ehr_onb_step1_h:'Ingresa el RFC<br>de tu <em>empresa</em>.',ehr_onb_step1_sub:'Verificaremos la información fiscal automáticamente.',ehr_onb_step1_placeholder:'RFC de la empresa (13 caracteres)',ehr_onb_step1_btn:'Verificar RFC',ehr_onb_step1_checking:'Verificando...',
    ehr_onb_step2_h:'Sube los documentos<br><em>requeridos</em>.',ehr_onb_step2_sub:'Documentos para completar la verificación de tu empresa.',ehr_onb_step2_rfc:'Constancia de Situación Fiscal',ehr_onb_step2_acta:'Acta Constitutiva',ehr_onb_step2_id:'Identificación del representante legal',ehr_onb_step2_address:'Comprobante de domicilio (< 3 meses)',
    ehr_onb_step3_h:'Resultados del<br><em>screening</em>.',ehr_onb_step3_sub:'Revisión de resultados del análisis. Pendiente de aprobación Parte B.',ehr_onb_step3_status:'Estado del screening',ehr_onb_step3_passed:'Aprobado',ehr_onb_step3_review:'En revisión',ehr_onb_step3_waiting:'Esperando aprobación Parte B...',
    ehr_onb_step4_h:'Integración de<br><em>nómina</em>.',ehr_onb_step4_sub:'Configura la conexión con tu sistema de nómina.',ehr_onb_step4_method:'Método de integración',ehr_onb_step4_api:'API directa',ehr_onb_step4_sftp:'SFTP',ehr_onb_step4_manual:'Manual (CSV)',ehr_onb_step4_payroll:'Sistema de nómina',ehr_onb_step4_frequency:'Frecuencia de nómina',ehr_onb_step4_weekly:'Semanal',ehr_onb_step4_biweekly:'Quincenal',ehr_onb_step4_monthly:'Mensual',ehr_onb_step4_save:'Guardar Configuración',ehr_onb_step4_saving:'Guardando...',ehr_onb_complete:'¡Configuración completada!',
    ehr_an_adoption:'Tasa de Adopción',ehr_an_loan_volume:'Volumen de Préstamos',ehr_an_default_rate:'Tasa de Morosidad',ehr_an_benchmark:'Benchmarking Sectorial',ehr_an_over_time:'Últimos 6 meses',ehr_an_by_month:'Por mes',ehr_an_by_cohort:'Por cohorte',ehr_an_sector_avg:'Promedio del sector',ehr_an_your_rate:'Tu empresa',ehr_an_no_data:'No hay datos suficientes para mostrar.',

    // Onboarding
    onb_welcome:'Bienvenido a <em>VIDA</em>',onb_welcome_sub:'Elige cómo quieres comenzar',onb_role_employer_title:'Soy Empleador',onb_role_employer_desc:'Quiero ofrecer VIDA como beneficio a mi equipo',onb_role_employee_title:'Soy Empleado',onb_role_employee_desc:'Mi empresa ya tiene VIDA y quiero acceder a mi crédito',onb_already_account:'¿Ya tienes cuenta?',onb_login:'Inicia sesión',
    onb_e_step1_h:'¿Cómo se llama<br>tu <em>empresa</em>?',onb_e_step1_sub:'Este será el nombre visible para tus empleados.',onb_e_step1_placeholder:'Nombre de tu empresa',onb_next:'Continuar',
    onb_e_step2_h:'Cuéntanos<br>sobre <em>ti</em>.',onb_e_step2_sub:'Información de contacto del administrador.',onb_e_step2_name:'Nombre completo',onb_e_step2_name_ph:'Tu nombre completo',onb_e_step2_email:'Correo electrónico',onb_e_step2_email_ph:'tu@empresa.com',
    onb_e_step3_h:'Sobre tu<br><em>empresa</em>.',onb_e_step3_sub:'Esto nos ayuda a personalizar tu experiencia.',onb_e_step3_size:'Tamaño de empresa',onb_e_step3_employees:'empleados',onb_e_step3_payroll:'Sistema de nómina',onb_e_step3_payroll_ph:'Selecciona tu sistema',onb_e_step3_payroll_other:'Otro',
    onb_e_step4_h:'Documentos<br><em>requeridos</em>.',onb_e_step4_sub:'Sube los documentos de tu empresa para verificación.',onb_e_step4_rfc:'Constancia de Situación Fiscal (RFC)',onb_e_step4_id:'Identificación oficial / Acta Constitutiva',onb_e_step4_address:'Comprobante de domicilio (< 3 meses)',onb_e_step4_upload:'Seleccionar archivo',onb_e_step4_uploading:'Subiendo...',onb_e_step4_done:'Archivo subido',onb_e_step4_error:'Error al subir',onb_e_step4_formats:'PDF o imagen, máx 5 MB',
    onb_e_step5_h:'Crea tu<br><em>cuenta</em>.',onb_e_step5_sub:'Un último paso para activar VIDA en tu empresa.',onb_e_step5_pass:'Contraseña',onb_e_step5_pass_ph:'Mínimo 6 caracteres',onb_e_step5_terms:'Acepto los',onb_e_step5_terms_link:'Términos y Condiciones',onb_e_step5_btn:'Crear Mi Cuenta',onb_e_step5_creating:'Creando cuenta...',
    onb_e_step6_h:'¡Cuenta<br><em>creada</em>!',onb_e_step6_sub:'Nuestro equipo revisará tus documentos en 24–48 horas hábiles.',onb_e_step6_badge:'Verificación en proceso',onb_e_step6_cta:'Ir al inicio',
    dash_doc_banner_h:'Completa tu verificación',dash_doc_banner_sub:'Sube los documentos requeridos para que podamos activar tu cuenta en 24–48 horas.',dash_doc_banner_success:'¡Documentos enviados! Los revisaremos en 24–48 horas.',
    onb_m_step1_h:'Ingresa tu<br><em>código</em>.',onb_m_step1_sub:'Tu empleador te proporcionó un código de acceso.',onb_m_step1_placeholder:'CÓDIGO',onb_m_step1_hint:'¿No tienes código? Pregunta a tu departamento de RH.',onb_m_step1_found:'Empresa encontrada',onb_m_step1_not_found:'Código no encontrado',onb_m_step1_searching:'Buscando...',
    onb_m_step2_h:'Cuéntanos<br>sobre <em>ti</em>.',onb_m_step2_sub:'Tu información personal para activar tu crédito.',onb_m_step2_name:'Nombre completo',onb_m_step2_name_ph:'Tu nombre completo',onb_m_step2_email:'Correo electrónico',onb_m_step2_email_ph:'tu@correo.com',
    onb_m_step3_h:'Tu crédito<br><em>pre-aprobado</em>.',onb_m_step3_sub:'Ingresa tu salario mensual para ver tu línea de crédito.',onb_m_step3_salary:'Salario mensual',onb_m_step3_salary_ph:'15,000',onb_m_step3_preapproved:'Pre-aprobado',onb_m_step3_credit_label:'CRÉDITO DISPONIBLE',
    onb_m_step4_h:'Crea tu<br><em>cuenta</em>.',onb_m_step4_sub:'Un último paso para acceder a tu crédito.',onb_m_step4_pass:'Contraseña',onb_m_step4_pass_ph:'Mínimo 6 caracteres',onb_m_step4_terms:'Acepto los',onb_m_step4_terms_link:'Términos y Condiciones',onb_m_step4_btn:'Activar Mi Crédito',onb_m_step4_creating:'Activando...',
    onb_m_step5_h:'¡Crédito<br><em>aprobado</em>!',onb_m_step5_sub:'Tu línea de crédito está lista para ser utilizada.',onb_m_step5_tag:'PRE-APROBADO',onb_m_step5_cta:'Acceder a Mi Crédito',
    onb_strength_weak:'Débil',onb_strength_medium:'Media',onb_strength_strong:'Fuerte',
    // Employer Landing
    lp_e_badge:'Para Empleadores',
    lp_e_h1:'Bienestar financiero<br>para tu <em>equipo</em>.',
    lp_e_sub:'Ofrece a tus empleados acceso a crédito de emergencia vía nómina. Sin riesgo para tu empresa. Sin carga operativa. Impacto medible en retención y productividad.',
    lp_e_cta:'Registrar Mi Empresa',
    lp_e_login:'¿Ya tienes cuenta?',
    lp_e_why_tag:'Por qué VIDA',
    lp_e_why_h:'Tu equipo merece<br>una red de <em>seguridad</em>.',
    lp_e_why_p:'El 78% de los empleados en México vive al día. El estrés financiero reduce productividad, aumenta ausentismo y dispara la rotación. VIDA resuelve esto.',
    lp_e_why_1_v:'78%',lp_e_why_1_l:'de empleados vive al día en México',
    lp_e_why_2_v:'3.2×',lp_e_why_2_l:'más productivos con estabilidad financiera',
    lp_e_why_3_v:'41%',lp_e_why_3_l:'de reducción en rotación voluntaria',
    lp_e_why_4_v:'$0',lp_e_why_4_l:'costo para tu empresa',
    lp_e_how_tag:'Cómo funciona',
    lp_e_how_h:'Integración en<br><em>minutos</em>, no meses.',
    lp_e_how_1_t:'Regístrate en 2 minutos',lp_e_how_1_d:'Crea tu cuenta, ingresa los datos de tu empresa y recibe un código único.',
    lp_e_how_2_t:'Comparte el código',lp_e_how_2_d:'Envía el código a tus empleados. Ellos se registran solos.',
    lp_e_how_3_t:'Tus empleados acceden',lp_e_how_3_d:'Crédito pre-aprobado de hasta $5,000 MXN. Fondos en 24 horas.',
    lp_e_how_4_t:'Deducción automática',lp_e_how_4_d:'Los pagos se descuentan de la nómina. Sin gestión manual.',
    lp_e_ben_tag:'Beneficios',
    lp_e_ben_h:'Cero riesgo.<br><em>Máximo</em> impacto.',
    lp_e_ben_1_t:'Sin responsabilidad financiera',lp_e_ben_1_d:'VIDA asume 100% del riesgo crediticio. Tu empresa no garantiza ni respalda los préstamos.',
    lp_e_ben_2_t:'Retención medible',lp_e_ben_2_d:'Empresas con VIDA reportan hasta 41% menos rotación en los primeros 6 meses.',
    lp_e_ben_3_t:'Integración universal',lp_e_ben_3_d:'Compatible con Nomipaq, Aspel NOI, CONTPAQi, Workday, ADP y cualquier sistema de nómina.',
    lp_e_ben_4_t:'Gobernanza institucional',lp_e_ben_4_d:'Holding suizo. SOFOM registrada en México. Encriptación bancaria. Precios transparentes.',
    lp_e_close_h:'Empodera a tu equipo<br><em>hoy</em>.',
    lp_e_close_sub:'Regístrate en 2 minutos. Sin contratos largos. Sin compromisos.',
    // Employee Landing
    lp_m_badge:'Para Empleados',
    lp_m_h1:'Tu red de<br><em>seguridad</em><br>financiera.',
    lp_m_sub:'Accede a crédito de emergencia pre-aprobado a través de tu empleador. Sin verificación crediticia. Sin papeleo. Fondos en 24 horas.',
    lp_m_cta:'Activar Mi Crédito',
    lp_m_no_code:'¿Tu empresa aún no tiene VIDA?',
    lp_m_no_code_link:'Diles cómo activarlo',
    lp_m_what_tag:'Qué obtienes',
    lp_m_what_h:'Crédito de emergencia,<br><em>ya aprobado</em>.',
    lp_m_what_1_v:'$5,000',lp_m_what_1_l:'Crédito máximo disponible',
    lp_m_what_2_v:'24 hrs',lp_m_what_2_l:'Fondos en tu cuenta',
    lp_m_what_3_v:'$0',lp_m_what_3_l:'Comisiones ocultas',
    lp_m_what_4_v:'Nómina',lp_m_what_4_l:'Deducción automática',
    lp_m_widget_tag:'Tu crédito',
    lp_m_widget_h:'Simula tu línea<br>de <em>crédito</em>.',
    lp_m_widget_sub:'Ingresa tu salario mensual y descubre cuánto puedes acceder. Tu crédito se calcula automáticamente como el 30% de tu salario, hasta un máximo de $5,000 MXN.',
    lp_m_widget_salary:'Salario mensual',
    lp_m_widget_salary_ph:'15,000',
    lp_m_widget_available:'Crédito disponible',
    lp_m_widget_rate:'Comisión',
    lp_m_widget_rate_val:'30% mensual',
    lp_m_widget_term:'Plazo',
    lp_m_widget_term_val:'30 días',
    lp_m_widget_repayment:'Pago total',
    lp_m_widget_deduction:'Deducción de nómina',
    lp_m_widget_disbursement:'Desembolso',
    lp_m_widget_disbursement_val:'En 24 horas',
    lp_m_widget_preapproved:'Pre-aprobado',
    lp_m_widget_no_check:'Sin verificación crediticia',
    lp_m_widget_no_paperwork:'Sin papeleo',
    lp_m_widget_cta:'Activar Mi Crédito',
    lp_m_how_tag:'Cómo funciona',
    lp_m_how_h:'Tres pasos.<br><em>Cero</em> complicaciones.',
    lp_m_how_1_t:'Obtén tu código',lp_m_how_1_d:'Tu empleador te proporcionará un código de acceso. Si no lo tienes, pídelo a RH.',
    lp_m_how_2_t:'Crea tu cuenta',lp_m_how_2_d:'Regístrate con tu código. Ingresa tu salario y descubre tu línea de crédito.',
    lp_m_how_3_t:'Solicita fondos',lp_m_how_3_d:'Elige el monto y plazo. Recibe fondos en 24 horas. Los pagos se descuentan de tu nómina.',
    lp_m_use_tag:'Úsalo cuando lo necesites',
    lp_m_use_h:'La vida no espera.<br><em>VIDA tampoco</em>.',
    lp_m_use_1_t:'Emergencias médicas',lp_m_use_1_d:'Visitas al hospital, recetas urgentes, tratamientos inesperados.',
    lp_m_use_2_t:'Reparaciones urgentes',lp_m_use_2_d:'Auto, hogar, electrodomésticos. Lo que no puede esperar.',
    lp_m_use_3_t:'Apoyo familiar',lp_m_use_3_d:'Cuando tus seres queridos te necesitan, tú necesitas liquidez.',
    lp_m_use_4_t:'Gastos inesperados',lp_m_use_4_d:'Cuentas que llegan sin aviso. Oportunidades que requieren acción.',
    lp_m_ask_tag:'¿Tu empresa no tiene VIDA?',
    lp_m_ask_h:'Dile a tu empleador<br>que active <em>VIDA</em>.',
    lp_m_ask_sub:'Muchos empleadores aún no conocen VIDA. Puedes ayudar a activarlo para ti y todos tus compañeros.',
    lp_m_ask_1_t:'Habla con RH',lp_m_ask_1_d:'Menciona VIDA en tu próxima conversación con Recursos Humanos. Es sin costo para la empresa.',
    lp_m_ask_2_t:'Comparte el enlace',lp_m_ask_2_d:'Envía vidacard.mx/hr a tu jefe o departamento de RH.',
    lp_m_ask_3_t:'Nosotros los contactamos',lp_m_ask_3_d:'Si prefieres, déjanos el contacto de tu empresa y los contactamos directamente.',
    lp_m_close_h:'Tu bienestar financiero<br>empieza <em>hoy</em>.',
    lp_m_close_sub:'Si tu empresa ya tiene VIDA, activa tu crédito en 2 minutos.',
    lp_m_close_cta:'Activar Mi Crédito',
    lp_m_close_cta2:'Mi Empresa No Tiene VIDA',
    // About
    pg_about_badge:'Nuestra Historia',
    pg_about_h1:'Construyendo resiliencia<br><em>financiera</em>.',
    pg_about_sub:'VIDA nace de una misión simple: nadie debería perder estabilidad por una emergencia financiera inesperada.',
    pg_about_mission_tag:'Misión',
    pg_about_mission_h:'Democratizar el acceso<br>al crédito de <em>emergencia</em>.',
    pg_about_mission_p:'En México, el 78% de los trabajadores formales vive al día. Una emergencia médica, una reparación urgente o un gasto familiar inesperado puede desestabilizar meses de progreso. VIDA existe para resolver este problema, conectando la infraestructura de nómina con crédito responsable y accesible.',
    pg_about_struct_tag:'Estructura',
    pg_about_struct_h:'Gobernanza suiza.<br>Operación <em>mexicana</em>.',
    pg_about_struct_1_t:'VIDA Holding AG',pg_about_struct_1_d:'Holding corporativo bajo regulación financiera suiza. Sede en Zúrich. Gobernanza, cumplimiento y supervisión estratégica.',
    pg_about_struct_2_t:'VIDA Finance SOFOM',pg_about_struct_2_d:'Entidad financiera registrada ante CONDUSEF en México. Operaciones de crédito, servicio al cliente y relaciones con empleadores.',
    pg_about_struct_3_t:'Infraestructura Tecnológica',pg_about_struct_3_d:'Plataforma propietaria construida con encriptación bancaria de extremo a extremo. Integración directa con sistemas de nómina.',
    pg_about_values_tag:'Valores',
    pg_about_values_h:'Los principios que nos <em>guían</em>.',
    pg_about_val_1_t:'Transparencia radical',pg_about_val_1_d:'Sin comisiones ocultas. Sin letra pequeña. Cada costo visible antes de firmar.',
    pg_about_val_2_t:'Responsabilidad primero',pg_about_val_2_d:'Límites de crédito conservadores. Nunca prestamos más de lo que puedes pagar cómodamente.',
    pg_about_val_3_t:'Privacidad absoluta',pg_about_val_3_d:'Tu empleador nunca ve tus préstamos individuales. Tu información financiera es tuya.',
    pg_about_val_4_t:'Impacto medible',pg_about_val_4_d:'Cada decisión de producto se mide por el impacto real en la vida de los empleados.',
    // Security
    pg_sec_badge:'Seguridad',
    pg_sec_h1:'Tu seguridad es<br>nuestra <em>prioridad</em>.',
    pg_sec_sub:'Protegemos tus datos con los mismos estándares que utilizan las instituciones financieras más exigentes del mundo.',
    pg_sec_enc_tag:'Encriptación',
    pg_sec_enc_h:'Protección de<br>grado <em>bancario</em>.',
    pg_sec_enc_1_t:'TLS 1.3 en tránsito',pg_sec_enc_1_d:'Toda la comunicación entre tu dispositivo y nuestros servidores está encriptada con el protocolo más avanzado disponible.',
    pg_sec_enc_2_t:'AES-256 en reposo',pg_sec_enc_2_d:'Tus datos almacenados están protegidos con el mismo estándar de encriptación que usa el gobierno de EE.UU. para información clasificada.',
    pg_sec_enc_3_t:'Hashing irreversible',pg_sec_enc_3_d:'Las contraseñas nunca se almacenan. Se transforman con bcrypt, haciéndolas irrecuperables incluso para nosotros.',
    pg_sec_enc_4_t:'Tokens efímeros',pg_sec_enc_4_d:'Las sesiones utilizan tokens de corta duración que se renuevan automáticamente y se invalidan al cerrar sesión.',
    pg_sec_infra_tag:'Infraestructura',
    pg_sec_infra_h:'Infraestructura de<br><em>clase mundial</em>.',
    pg_sec_infra_p:'Nuestra plataforma opera sobre infraestructura cloud de nivel empresarial, alojada en centros de datos certificados SOC 1, SOC 2 y SOC 3, ISO 27001, con redundancia geográfica, respaldos automáticos, protección DDoS integrada, y auditorías de seguridad continuas por terceros independientes.',
    pg_sec_infra_1_v:'99.95%',pg_sec_infra_1_l:'Disponibilidad garantizada (SLA)',
    pg_sec_infra_2_v:'SOC 2',pg_sec_infra_2_l:'Tipo II certificado',
    pg_sec_infra_3_v:'ISO 27001',pg_sec_infra_3_l:'Gestión de seguridad de la información',
    pg_sec_infra_4_v:'GDPR',pg_sec_infra_4_l:'Cumplimiento regulatorio europeo',
    pg_sec_infra_5_v:'DDoS',pg_sec_infra_5_l:'Protección automática contra ataques',
    pg_sec_infra_6_v:'24/7',pg_sec_infra_6_l:'Monitoreo continuo de infraestructura',
    pg_sec_practices_tag:'Prácticas',
    pg_sec_practices_h:'Seguridad en cada <em>capa</em>.',
    pg_sec_pr_1_t:'Autenticación multifactor',pg_sec_pr_1_d:'Verificación en dos pasos disponible para todas las cuentas de empleador.',
    pg_sec_pr_2_t:'Monitoreo 24/7',pg_sec_pr_2_d:'Sistemas de detección de intrusiones y anomalías operando continuamente.',
    pg_sec_pr_3_t:'Principio de mínimo privilegio',pg_sec_pr_3_d:'Cada servicio interno solo accede a los datos estrictamente necesarios para su función.',
    pg_sec_pr_4_t:'Auditorías regulares',pg_sec_pr_4_d:'Pruebas de penetración y revisiones de seguridad realizadas por terceros independientes.',
    // Privacy Policy
    pg_priv_badge:'Legal',
    pg_priv_h1:'Política de<br><em>Privacidad</em>.',
    pg_priv_updated:'Última actualización: 1 de enero de 2025',
    pg_priv_intro:'En VIDA Finance ("VIDA", "nosotros"), nos comprometemos a proteger tu información personal. Esta Política de Privacidad describe cómo recopilamos, usamos, almacenamos y protegemos tus datos cuando utilizas nuestra plataforma.',
    pg_priv_1_t:'1. Información que recopilamos',
    pg_priv_1_p:'Recopilamos la información que nos proporcionas directamente al crear tu cuenta: nombre completo, dirección de correo electrónico, nombre de la empresa (empleadores), código de empleador (empleados), salario mensual declarado (empleados) y contraseña encriptada. También recopilamos datos de uso como dirección IP, tipo de navegador, páginas visitadas y marcas de tiempo.',
    pg_priv_2_t:'2. Cómo usamos tu información',
    pg_priv_2_p:'Utilizamos tu información para: procesar y administrar solicitudes de crédito, verificar tu identidad y elegibilidad, comunicarnos contigo sobre tu cuenta y préstamos, mejorar nuestros servicios y experiencia de usuario, cumplir con obligaciones legales y regulatorias, y prevenir fraude y actividades no autorizadas.',
    pg_priv_3_t:'3. Compartición de datos',
    pg_priv_3_p:'No vendemos tu información personal. Compartimos datos limitados con: tu empleador (solo confirmación de registro, nunca detalles de préstamos individuales), proveedores de infraestructura cloud certificados que nos ayudan a operar la plataforma de forma segura, y autoridades regulatorias cuando la ley lo requiere.',
    pg_priv_4_t:'4. Seguridad de datos',
    pg_priv_4_p:'Protegemos tu información con encriptación TLS 1.3 en tránsito, AES-256 en reposo, hashing irreversible de contraseñas, control de acceso basado en roles, y monitoreo continuo de seguridad. Para más detalles, consulta nuestra página de Seguridad.',
    pg_priv_5_t:'5. Retención de datos',
    pg_priv_5_p:'Conservamos tu información personal mientras mantengas una cuenta activa y durante el período requerido por las regulaciones financieras mexicanas (mínimo 10 años para registros de transacciones). Puedes solicitar la eliminación de tu cuenta en cualquier momento, sujeto a las obligaciones legales de retención.',
    pg_priv_6_t:'6. Tus derechos',
    pg_priv_6_p:'De acuerdo con la Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP), tienes derecho a: acceder a tus datos personales, rectificar datos inexactos, cancelar el tratamiento de tus datos, oponerte al uso de tus datos (derechos ARCO). Para ejercer estos derechos, contacta a privacidad@vidacard.mx.',
    pg_priv_7_t:'7. Cookies y tecnologías similares',
    pg_priv_7_p:'Utilizamos cookies esenciales para el funcionamiento de la plataforma, cookies de preferencia para recordar tu idioma y sesión, y herramientas de análisis para mejorar nuestros servicios. No utilizamos cookies de publicidad de terceros.',
    pg_priv_8_t:'8. Contacto',
    pg_priv_8_p:'Para preguntas sobre esta política, contacta a nuestro Oficial de Protección de Datos en privacidad@vidacard.mx o escríbenos a VIDA Finance, Ciudad de México, México.',
    // Terms
    pg_terms_badge:'Legal',
    pg_terms_h1:'Términos de<br><em>Servicio</em>.',
    pg_terms_updated:'Última actualización: 1 de enero de 2025',
    pg_terms_intro:'Estos Términos de Servicio ("Términos") regulan el uso de la plataforma VIDA Finance ("VIDA", "la Plataforma"). Al crear una cuenta o utilizar nuestros servicios, aceptas estos Términos en su totalidad.',
    pg_terms_1_t:'1. Definiciones',
    pg_terms_1_p:'"Empleador" se refiere a la empresa registrada que ofrece VIDA como beneficio. "Empleado" se refiere al trabajador que accede a crédito a través de su empleador registrado. "Crédito" se refiere al préstamo de corto plazo otorgado al Empleado. "Código de Empleador" es el identificador único asignado a cada Empleador para vincular a sus Empleados.',
    pg_terms_2_t:'2. Elegibilidad',
    pg_terms_2_p:'Para usar la Plataforma como Empleador, debes ser una empresa legalmente constituida en México con al menos un empleado activo. Como Empleado, debes contar con un Código de Empleador válido, ser mayor de 18 años, y tener una relación laboral activa con un Empleador registrado.',
    pg_terms_3_t:'3. Créditos y condiciones',
    pg_terms_3_p:'Los créditos tienen un límite máximo de $5,000 MXN, calculado en función del salario mensual declarado (hasta 30% del salario). El plazo es de 30 días con una comisión del 30% sobre el monto solicitado. No existen comisiones ocultas, penalidades por pago anticipado, ni cargos adicionales. Los pagos se deducen automáticamente de la nómina del Empleado.',
    pg_terms_4_t:'4. Obligaciones del Empleador',
    pg_terms_4_p:'El Empleador se compromete a: proporcionar información veraz de la empresa, facilitar la deducción de nómina para el pago de créditos, no discriminar a empleados que utilicen VIDA, y mantener confidencial la información de la plataforma. El Empleador no asume responsabilidad financiera por los créditos otorgados a sus empleados.',
    pg_terms_5_t:'5. Obligaciones del Empleado',
    pg_terms_5_p:'El Empleado se compromete a: proporcionar información personal veraz, autorizar la deducción automática de nómina, notificar cambios en su situación laboral, no compartir sus credenciales de acceso, y utilizar los fondos de manera responsable.',
    pg_terms_6_t:'6. Propiedad intelectual',
    pg_terms_6_p:'Todo el contenido de la Plataforma, incluyendo diseño, textos, logotipos, código fuente y marca VIDA, es propiedad de VIDA Holding AG y está protegido por leyes de propiedad intelectual. Se prohíbe su reproducción sin autorización escrita.',
    pg_terms_7_t:'7. Limitación de responsabilidad',
    pg_terms_7_p:'VIDA no será responsable por: interrupciones temporales del servicio, decisiones financieras tomadas por los usuarios, cambios en la situación laboral del Empleado, ni daños indirectos derivados del uso de la Plataforma. VIDA se reserva el derecho de modificar, suspender o descontinuar cualquier aspecto del servicio.',
    pg_terms_8_t:'8. Ley aplicable',
    pg_terms_8_p:'Estos Términos se rigen por las leyes de los Estados Unidos Mexicanos. Cualquier disputa será resuelta ante los tribunales competentes de la Ciudad de México. Para consultas legales, contacta a legal@vidacard.mx.',
    // Partners
    pg_part_badge:'Programa de Socios',
    pg_part_h1:'Crece con<br><em>VIDA</em>.',
    pg_part_sub:'Únete a nuestro ecosistema de socios y lleva bienestar financiero a miles de empleados en México.',
    pg_part_cta:'Aplica como Socio',
    pg_part_who_tag:'Para quién',
    pg_part_who_h:'Diseñado para quienes<br>ya hablan con <em>empresas</em>.',
    pg_part_who_1_t:'Consultoras de RH',pg_part_who_1_d:'Ofrece VIDA como parte de tu portafolio de beneficios para empleados.',
    pg_part_who_2_t:'Proveedores de Nómina',pg_part_who_2_d:'Integra VIDA directamente en tu plataforma de nómina y agrega valor a tus clientes.',
    pg_part_who_3_t:'Brokers de Seguros',pg_part_who_3_d:'Complementa tu oferta de protección financiera con crédito de emergencia.',
    pg_part_who_4_t:'Asociaciones Empresariales',pg_part_who_4_d:'Lleva un beneficio tangible a los miembros de tu cámara o asociación.',
    pg_part_how_tag:'Cómo funciona',
    pg_part_how_h:'Tres pasos para<br>ser <em>socio</em>.',
    pg_part_how_1_t:'Aplica',pg_part_how_1_d:'Completa el formulario de aplicación. Nuestro equipo revisará tu perfil en 48 horas.',
    pg_part_how_2_t:'Integra',pg_part_how_2_d:'Recibe materiales, capacitación y tu enlace de referencia personalizado.',
    pg_part_how_3_t:'Gana',pg_part_how_3_d:'Comisión recurrente por cada empleador activo que refieras a VIDA.',
    pg_part_ben_tag:'Beneficios',
    pg_part_ben_h:'Una alianza que<br><em>funciona</em>.',
    pg_part_ben_1_v:'15%',pg_part_ben_1_l:'Comisión recurrente sobre ingresos generados',
    pg_part_ben_2_v:'$0',pg_part_ben_2_l:'Costo de integración o membresía',
    pg_part_ben_3_v:'24/7',pg_part_ben_3_l:'Soporte dedicado para socios',
    pg_part_ben_4_v:'∞',pg_part_ben_4_l:'Sin límite de referidos',
    // Investors
    pg_inv_badge:'Inversionistas',
    pg_inv_h1:'La oportunidad del<br>crédito de <em>nómina</em>.',
    pg_inv_sub:'Un mercado de $23B desatendido en México. Infraestructura regulada. Modelo de negocio probado. Gobernanza suiza.',
    pg_inv_market_tag:'Mercado',
    pg_inv_market_h:'Un mercado masivo<br><em>desatendido</em>.',
    pg_inv_market_p:'55 millones de trabajadores formales en México. El 78% sin acceso a crédito de emergencia responsable. Las alternativas existentes cobran tasas superiores al 400% anual.',
    pg_inv_market_1_v:'$23B',pg_inv_market_1_l:'Mercado direccionable total',
    pg_inv_market_2_v:'55M',pg_inv_market_2_l:'Trabajadores formales en México',
    pg_inv_market_3_v:'78%',pg_inv_market_3_l:'Sin acceso a crédito formal',
    pg_inv_market_4_v:'<2%',pg_inv_market_4_l:'Penetración actual de EWA en México',
    pg_inv_model_tag:'Modelo',
    pg_inv_model_h:'Unit economics<br><em>probados</em>.',
    pg_inv_model_1_t:'Adquisición vía empleador',pg_inv_model_1_d:'Un empleador integrado = acceso a cientos de empleados. CAC por empleado cercano a $0.',
    pg_inv_model_2_t:'Deducción de nómina',pg_inv_model_2_d:'Tasa de default inferior al 2% gracias a la deducción automática de nómina.',
    pg_inv_model_3_t:'Ingresos recurrentes',pg_inv_model_3_d:'Comisiones por transacción con alta recurrencia. Los empleados solicitan crédito en promedio 3.2 veces por año.',
    pg_inv_model_4_t:'Escalabilidad regulada',pg_inv_model_4_d:'Licencia SOFOM permite escalar operaciones sin necesidad de licencia bancaria completa.',
    pg_inv_gov_tag:'Gobernanza',
    pg_inv_gov_h:'Estructura institucional<br>desde el <em>día uno</em>.',
    pg_inv_gov_p:'VIDA Holding AG en Suiza. VIDA Finance SOFOM en México. Consejo de administración independiente. Auditorías trimestrales. Cumplimiento regulatorio completo.',
    pg_inv_cta:'Solicitar Deck de Inversionista',
    pg_inv_cta_email:'investor.relations@vidacard.mx',
    // Contact
    pg_contact_badge:'Contacto',
    pg_contact_h1:'Hablemos<br>de <em>VIDA</em>.',
    pg_contact_sub:'Estamos aquí para responder tus preguntas, explorar alianzas o simplemente conversar.',
    pg_contact_general_t:'Consultas generales',pg_contact_general_v:'hola@vidacard.mx',
    pg_contact_employers_t:'Empleadores',pg_contact_employers_v:'empresas@vidacard.mx',
    pg_contact_press_t:'Prensa',pg_contact_press_v:'prensa@vidacard.mx',
    pg_contact_investors_t:'Inversionistas',pg_contact_investors_v:'investor.relations@vidacard.mx',
    pg_contact_privacy_t:'Privacidad',pg_contact_privacy_v:'privacidad@vidacard.mx',
    pg_contact_office_tag:'Oficinas',
    pg_contact_office_mx_t:'Ciudad de México',pg_contact_office_mx_d:'Av. Paseo de la Reforma 250, Piso 12<br>Col. Juárez, 06600 CDMX, México',
    pg_contact_office_ch_t:'Zúrich',pg_contact_office_ch_d:'Bahnhofstrasse 42<br>8001 Zúrich, Suiza',
    pg_contact_form_name:'Nombre',pg_contact_form_name_ph:'Tu nombre',
    pg_contact_form_email:'Correo',pg_contact_form_email_ph:'tu@correo.com',
    pg_contact_form_type:'Tipo de consulta',
    pg_contact_form_type_general:'Consulta general',pg_contact_form_type_employer:'Soy empleador',pg_contact_form_type_partner:'Quiero ser socio',pg_contact_form_type_investor:'Soy inversionista',pg_contact_form_type_press:'Prensa',pg_contact_form_type_other:'Otro',
    pg_contact_form_msg:'Mensaje',pg_contact_form_msg_ph:'¿En qué podemos ayudarte?',
    pg_contact_form_send:'Enviar Mensaje',pg_contact_form_sent:'¡Mensaje enviado! Te responderemos pronto.',
    // Press
    pg_press_badge:'Prensa',
    pg_press_h1:'VIDA en los<br><em>medios</em>.',
    pg_press_sub:'Recursos, datos y materiales para periodistas e investigadores.',
    pg_press_kit_tag:'Kit de Prensa',
    pg_press_kit_h:'Todo lo que necesitas<br>para cubrir <em>VIDA</em>.',
    pg_press_kit_1_t:'Sobre VIDA',pg_press_kit_1_d:'VIDA es una plataforma de crédito de emergencia habilitada por el empleador. Permite a los empleados de empresas registradas acceder a préstamos de hasta $5,000 MXN con deducción automática de nómina, sin verificación crediticia y con fondos en 24 horas.',
    pg_press_kit_2_t:'Datos clave',pg_press_kit_2_d:'Fundada en 2024. Holding en Suiza (VIDA Holding AG). Operación en México (VIDA Finance SOFOM). Créditos de $500 a $5,000 MXN. Plazo de 30 días. Comisión del 30% mensual. Sin comisiones ocultas.',
    pg_press_kit_3_t:'El problema que resolvemos',pg_press_kit_3_d:'El 78% de los trabajadores formales en México vive al día. Las alternativas de crédito informal cobran tasas superiores al 400% anual. VIDA ofrece crédito responsable a través de la infraestructura de nómina del empleador.',
    pg_press_contact_tag:'Contacto de Prensa',
    pg_press_contact_p:'Para entrevistas, datos o información adicional:',
    pg_press_contact_email:'prensa@vidacard.mx',
    pg_press_brand_tag:'Marca',
    pg_press_brand_h:'Guía de <em>marca</em>.',
    pg_press_brand_1_t:'Nombre',pg_press_brand_1_d:'VIDA — siempre en mayúsculas. El nombre completo es "VIDA Finance" para contextos formales.',
    pg_press_brand_2_t:'Color principal',pg_press_brand_2_d:'Teal oscuro #194445 — usado en el logotipo, textos principales y elementos de marca.',
    pg_press_brand_3_t:'Color acento',pg_press_brand_3_d:'Dorado #C9A84C — usado como color de señal, nunca como fondo. Reservado para destacar datos clave.',
    pg_press_brand_4_t:'Tipografía',pg_press_brand_4_d:'DM Serif Display para titulares. DM Sans para cuerpo de texto. Ambas de Google Fonts.',
    // Ops Dashboard
    ops_title:'VIDA OPS',ops_signout:'Cerrar sesión',
    ops_nav_review:'Cola de Revisión',ops_nav_portfolio:'Portafolio',ops_nav_employers:'Empleadores',ops_nav_alerts:'Alertas',
    // Review Queue
    ops_rq_title:'Cola de Revisión Manual',ops_rq_empty:'Sin revisiones pendientes',
    ops_rq_sort_risk:'Riesgo',ops_rq_sort_sla:'SLA',ops_rq_sort_confidence:'Confianza',
    ops_rq_sla_label:'SLA',ops_rq_sla_expired:'Expirado',
    ops_rq_col_applicant:'Solicitante',ops_rq_col_amount:'Monto',ops_rq_col_risk:'Nivel de Riesgo',ops_rq_col_confidence:'Confianza',ops_rq_col_sla:'Tiempo SLA',ops_rq_col_status:'Estado',ops_rq_col_actions:'Acciones',
    ops_rq_risk_high:'Alto',ops_rq_risk_medium:'Medio',ops_rq_risk_low:'Bajo',
    ops_rq_btn_approve:'Aprobar',ops_rq_btn_reject:'Rechazar',ops_rq_btn_info:'Solicitar Info',
    ops_rq_detail_narrative:'Narrativa de Riesgo LLM',ops_rq_detail_signals:'Señales (Etapas 0-4)',ops_rq_detail_shap:'SHAP Top-5 Características',
    ops_rq_notes_placeholder:'Notas del analista...',ops_rq_confirm:'Confirmar',
    ops_rq_toast_approved:'Revisión aprobada',ops_rq_toast_rejected:'Revisión rechazada',ops_rq_toast_info:'Información adicional solicitada',
    // Portfolio
    ops_pf_title:'Panel de Portafolio',
    ops_pf_active_size:'Cartera Activa',ops_pf_outstanding:'Total Pendiente',ops_pf_default_rate:'Tasa de Morosidad',ops_pf_trend:'Tendencia',
    ops_pf_by_status:'Préstamos por Estado',ops_pf_by_employer:'Agregación por Empleador',
    ops_pf_col_employer:'Empleador',ops_pf_col_loans:'Préstamos',ops_pf_col_outstanding:'Pendiente',ops_pf_col_compliance:'Cumplimiento Deducción',
    ops_pf_cohort:'Análisis de Cohorte',ops_pf_cohort_month:'Mes de Originación',ops_pf_cohort_count:'Préstamos',ops_pf_cohort_default:'Tasa Morosidad',
    ops_pf_status_pending:'Pendiente',ops_pf_status_active:'Activo',ops_pf_status_overdue:'Vencido',ops_pf_status_paid:'Pagado',ops_pf_status_defaulted:'Incumplido',
    // Employer Management
    ops_em_title:'Gestión de Empleadores',ops_em_empty:'Sin empleadores',
    ops_em_col_company:'Empresa',ops_em_col_tier:'Tier',ops_em_col_score:'Puntuación',ops_em_col_slots:'Slots Activos',ops_em_col_employees:'Empleados',ops_em_col_actions:'Acciones',
    ops_em_btn_expand:'Expandir Slots',ops_em_btn_upgrade:'Subir a Tier 1',ops_em_btn_history:'Historial',
    ops_em_expand_title:'Expandir slots',ops_em_expand_placeholder:'Nuevos slots',ops_em_expand_confirm:'Confirmar',
    ops_em_toast_expanded:'Slots expandidos',ops_em_toast_upgraded:'Empleador subido a Tier 1',
    ops_em_screening:'Historial de Screening',ops_em_screening_empty:'Sin historial',
    // Alerts
    ops_al_title:'Panel de Salud del Sistema',ops_al_empty:'Sin datos de salud',
    ops_al_services:'Servicios',ops_al_queues:'Profundidad de Colas',ops_al_drift:'Indicadores de Drift',
    ops_al_col_service:'Servicio',ops_al_col_status:'Estado',ops_al_col_latency:'Latencia',ops_al_col_checked:'Última Verificación',
    ops_al_col_queue:'Cola',ops_al_col_waiting:'En Espera',ops_al_col_active:'Activo',ops_al_col_failed:'Fallido',ops_al_col_completed:'Completado',
    ops_al_status_ok:'Operativo',ops_al_status_degraded:'Degradado',ops_al_status_down:'Caído',
    ops_al_drift_psi:'PSI (Estabilidad de Población)',ops_al_drift_csi:'CSI (Estabilidad de Características)',ops_al_drift_status:'Estado',ops_al_drift_ok:'Normal',ops_al_drift_warning:'Advertencia',ops_al_drift_alert:'Alerta',
  },
  en: {
    nav_employers:'Employers',nav_employees:'Employees',nav_trust:'Trust',nav_how:'How it works',nav_login:'Log in',nav_get_started:'Get Started',nav_partners:'Partners',nav_investors:'Investors',nav_contact:'Contact',lang_toggle:'ES',
    hero_badge:'Employer-Enabled Credit',hero_h1:'Your built-in<br><em>financial</em><br>backup.',hero_sub:'Emergency liquidity through your employer\'s payroll. Pre-approved. Instant.',hero_cta_employer:'I\'m an Employer',hero_cta_employee:'I\'m an Employee',
    phone_available:'Available Credit',phone_active:'Active',phone_currency:'Mexican Pesos · Via payroll',phone_repayment:'Repayment',phone_repayment_val:'30 days',phone_disbursement:'Disbursement',phone_disbursement_val:'Within 24 hrs',phone_deduction:'Deduction',phone_deduction_val:'Auto payroll',phone_utilization:'Utilization',phone_request:'Request Funds',
    chip_24hrs:'24 hrs',chip_disbursement:'Disbursement',chip_0fees:'$0 fees',chip_transparent:'Transparent',chip_encrypted:'Encrypted',chip_bankgrade:'Bank-grade',
    ben_fees:'Hidden fees',ben_disbursement:'Disbursement',ben_encrypted:'Encrypted',ben_governance:'Governance',
    stmt_h2:'Life is<br><em>unpredictable.</em>',stmt_p:'VIDA is your employer-backed safety net for when it matters most.',
    emo_1_title:'Unexpected expenses',emo_1_desc:'Bills that arrive without warning',emo_2_title:'Medical emergencies',emo_2_desc:'Hospital visits or urgent prescriptions',emo_3_title:'Family needs',emo_3_desc:'Supporting loved ones in tough moments',emo_4_title:'Repair bills',emo_4_desc:'Car, home, or appliance breakdowns',
    hiw_tag:'How it works',hiw_h2:'Access emergency credit, already enabled by your company.',hiw_p:'Four steps. No paperwork. No credit checks.',step_1_title:'Employer integrates',step_1_desc:'Your company connects VIDA to payroll — zero operational burden.',step_2_title:'You get pre-approved',step_2_desc:'A structured credit line up to $5,000 MXN. No checks needed.',step_3_title:'Request funds',step_3_desc:'Receive funds within 24 hours. 30-day term with automatic deduction.',step_4_title:'Automatic deduction',step_4_desc:'Repayments deducted from payroll. No manual payments.',
    calc_tag:'Simulate',calc_h2:'See how much<br>you can access.',calc_p:'Calculate your credit line in seconds. Adjust your salary and desired amount below.',calc_salary:'Monthly salary',calc_salary_placeholder:'Enter your salary',calc_credit:'Desired credit',calc_term:'Repayment term',calc_days:'days',calc_rate:'30% monthly',calc_result_label:'Estimated repayment',calc_note:'Funds available within 24 hours',calc_cta:'Request Access',
    emp_tag:'For Employers',emp_h2:'Offer financial stability without burden.',emp_p:'Zero liability. Simple integration. Measurable retention impact.',emp_link:'Explore Employer Benefits',emp_retention:'Retention rate',emp_liability:'Employer liability',emp_liability_c:'Zero risk',emp_integration:'Integration',emp_integration_c:'Payroll API',emp_adoption:'Adoption rate',
    scn_tag:'For Employees',scn_h2:'Support when it matters most.',scn_p:'No credit checks. Pre-approved. Transparent.',scn_1_title:'Medical emergency',scn_1_desc:'Hospital visit or urgent prescription',scn_2_title:'Car repair',scn_2_desc:'Vehicle you depend on for work',scn_3_title:'Home emergency',scn_3_desc:'Plumbing, electrical, appliance',scn_4_title:'Family support',scn_4_desc:'Help through a tough moment',
    trust_tag:'Trust',trust_h2:'Built on institutional governance.',trust_p:'Regulated, encrypted, transparent.',trust_1_title:'Swiss Governance',trust_1_desc:'Holding under Swiss financial regulation',trust_2_title:'SOFOM Registered',trust_2_desc:'Licensed and regulated in Mexico',trust_3_title:'Bank-grade Encryption',trust_3_desc:'Your data protected at every layer',trust_4_title:'Transparent Pricing',trust_4_desc:'No hidden fees, clear cost structure',trust_link:'View Compliance',
    close_h2:'Financial life. <em>Reinvented.</em>',close_sub:'Join hundreds of employers building financial resilience.',close_cta:'Get Started',
    ft_tagline:'Employer-enabled emergency credit. Swiss-governed. Mexico-operating.',ft_platform:'Platform',ft_company:'Company',ft_about:'About',ft_security:'Security',ft_privacy:'Privacy',ft_terms:'Terms',ft_connect:'Connect',ft_press:'Press',ft_privacy_policy:'Privacy Policy',ft_terms_service:'Terms of Service',
    auth_welcome:'Welcome back',auth_signin_sub:'Sign in to your account',auth_email:'Email',auth_email_placeholder:'you@company.com',auth_password:'Password',auth_password_placeholder:'Your password',auth_signin_btn:'Sign In',auth_signing_in:'Signing in...',auth_no_account:'Don\'t have an account?',auth_signup_link:'Sign up',auth_has_account:'Already have an account?',auth_login_link:'Sign in',auth_invalid_code:'Invalid employer code. Please check with your HR department.',
    dash_dashboard:'Dashboard',dash_employees:'Employees',dash_loans:'Loans',dash_signout:'Sign out',dash_employer_code:'Employer Code',dash_total_employees:'Total Employees',dash_active_loans:'Active Loans',dash_pending_requests:'Pending Requests',dash_total_disbursed:'Total Disbursed',dash_recent_loans:'Recent Loan Requests',dash_th_employee:'Employee',dash_th_amount:'Amount',dash_th_term:'Term',dash_th_status:'Status',dash_th_docs:'Documents',dash_th_action:'Action',dash_approve:'Approve',dash_reject:'Reject',dash_no_loans_employer:'No loan requests yet. Share your employer code',dash_no_loans_employer_2:'with employees.',dash_days:'days',dash_doc_contract:'Contract',dash_doc_receipt:'Receipt',dash_doc_generating:'Generating...',
    dash_welcome:'Welcome',dash_available_credit:'Available Credit',dash_credit_limit:'Credit Limit',dash_utilization:'Utilization',dash_quick_action:'Quick Action',dash_request_funds:'Request Funds',dash_your_loans:'Your Loans',dash_my_loans:'My Loans',dash_th_repayment:'Repayment',dash_th_date:'Date',dash_no_loans_employee:'No loans yet. Request your first emergency fund above.',
    modal_request:'Request Funds',modal_available:'Available',modal_amount:'Amount (MXN)',modal_term:'Repayment Term',modal_term_30:'30 days',modal_rate:'30% monthly',modal_loan_amount:'Loan amount',modal_fee:'Fee (30%)',modal_total:'Total repayment',modal_confirm:'Confirm Request',modal_submitting:'Submitting...',modal_exceed:'Amount exceeds available credit',modal_minimum:'Minimum amount is $500 MXN',
    toast_loan_approved:'Loan approved',toast_loan_rejected:'Loan rejected',toast_loan_submitted:'Request submitted. Your employer will be notified.',modal_accept_terms:'I accept the terms and conditions',modal_due_date:'Due date',
    status_pending:'pending',status_approved:'approved',status_disbursement_queued:'disbursement queued',status_active:'active',status_rejected:'rejected',status_paid:'paid',status_overdue:'overdue',
    tab_all:'All',tab_pending:'Pending',tab_approved:'Approved',tab_active:'Active',tab_paid:'Completed',tab_rejected:'Rejected',
    dash_emp_name:'Name',dash_emp_email:'Email',dash_emp_limit:'Limit',dash_emp_available:'Available',dash_emp_registered:'Registered',dash_emp_search_placeholder:'Search by name or email...',dash_no_employees:'No employees registered yet.',

    // Employer HR Dashboard
    ehr_overview:'Overview',ehr_employees:'Employees',ehr_deductions:'Deductions',ehr_onboarding:'Onboarding',ehr_analytics:'Analytics',
    ehr_total_employees:'Total Employees',ehr_active_loans:'Active Loans',ehr_total_disbursed:'Total Disbursed',ehr_overdue_count:'Overdue',ehr_adoption_rate:'Adoption Rate',ehr_outstanding:'Outstanding Balance',
    ehr_upcoming_deductions:'Upcoming Deductions',ehr_th_employee_id:'Employee ID',ehr_th_amount:'Amount',ehr_th_due_date:'Due Date',ehr_th_loan_id:'Loan ID',ehr_no_deductions:'No upcoming deductions.',
    ehr_emp_status:'Status',ehr_emp_active:'Active',ehr_emp_inactive:'Inactive',ehr_emp_credit:'Available Credit',ehr_emp_loans:'Active Loans',ehr_emp_search:'Search employee...',ehr_emp_filter_all:'All',ehr_emp_filter_active:'Active',ehr_emp_filter_inactive:'Inactive',ehr_no_employees:'No employees registered.',
    ehr_ded_current:'Current Cycle',ehr_ded_history:'History',ehr_ded_employee:'Employee',ehr_ded_amount:'Amount',ehr_ded_due:'Due Date',ehr_ded_status:'Status',ehr_ded_loan:'Loan',ehr_ded_deducted:'Deducted',ehr_ded_pending:'Pending',ehr_ded_missed:'Missed',ehr_ded_export:'Export CSV',ehr_no_deductions_hist:'No deductions recorded.',ehr_ded_month:'Month',
    ehr_onb_step1_h:'Enter your company<br><em>RFC</em>.',ehr_onb_step1_sub:'We will automatically verify your tax information.',ehr_onb_step1_placeholder:'Company RFC (13 characters)',ehr_onb_step1_btn:'Verify RFC',ehr_onb_step1_checking:'Verifying...',
    ehr_onb_step2_h:'Upload required<br><em>documents</em>.',ehr_onb_step2_sub:'Documents to complete your company verification.',ehr_onb_step2_rfc:'Tax Registration Certificate',ehr_onb_step2_acta:'Articles of Incorporation',ehr_onb_step2_id:'Legal representative ID',ehr_onb_step2_address:'Proof of address (< 3 months)',
    ehr_onb_step3_h:'Screening<br><em>results</em>.',ehr_onb_step3_sub:'Review of screening analysis results. Pending Part B approval.',ehr_onb_step3_status:'Screening status',ehr_onb_step3_passed:'Passed',ehr_onb_step3_review:'Under review',ehr_onb_step3_waiting:'Awaiting Part B approval...',
    ehr_onb_step4_h:'Payroll<br><em>integration</em>.',ehr_onb_step4_sub:'Configure the connection with your payroll system.',ehr_onb_step4_method:'Integration method',ehr_onb_step4_api:'Direct API',ehr_onb_step4_sftp:'SFTP',ehr_onb_step4_manual:'Manual (CSV)',ehr_onb_step4_payroll:'Payroll system',ehr_onb_step4_frequency:'Pay frequency',ehr_onb_step4_weekly:'Weekly',ehr_onb_step4_biweekly:'Biweekly',ehr_onb_step4_monthly:'Monthly',ehr_onb_step4_save:'Save Configuration',ehr_onb_step4_saving:'Saving...',ehr_onb_complete:'Configuration complete!',
    ehr_an_adoption:'Adoption Rate',ehr_an_loan_volume:'Loan Volume',ehr_an_default_rate:'Default Rate',ehr_an_benchmark:'Sector Benchmarking',ehr_an_over_time:'Last 6 months',ehr_an_by_month:'By month',ehr_an_by_cohort:'By cohort',ehr_an_sector_avg:'Sector average',ehr_an_your_rate:'Your company',ehr_an_no_data:'Not enough data to display.',

    // Onboarding
    onb_welcome:'Welcome to <em>VIDA</em>',onb_welcome_sub:'Choose how you want to get started',onb_role_employer_title:'I\'m an Employer',onb_role_employer_desc:'I want to offer VIDA as a benefit for my team',onb_role_employee_title:'I\'m an Employee',onb_role_employee_desc:'My company already has VIDA and I want to access my credit',onb_already_account:'Already have an account?',onb_login:'Sign in',
    onb_e_step1_h:'What\'s your<br><em>company</em> name?',onb_e_step1_sub:'This will be visible to your employees.',onb_e_step1_placeholder:'Your company name',onb_next:'Continue',
    onb_e_step2_h:'Tell us<br>about <em>you</em>.',onb_e_step2_sub:'Admin contact information.',onb_e_step2_name:'Full name',onb_e_step2_name_ph:'Your full name',onb_e_step2_email:'Email address',onb_e_step2_email_ph:'you@company.com',
    onb_e_step3_h:'About your<br><em>company</em>.',onb_e_step3_sub:'This helps us personalize your experience.',onb_e_step3_size:'Company size',onb_e_step3_employees:'employees',onb_e_step3_payroll:'Payroll system',onb_e_step3_payroll_ph:'Select your system',onb_e_step3_payroll_other:'Other',
    onb_e_step4_h:'Required<br><em>documents</em>.',onb_e_step4_sub:'Upload your company documents for verification.',onb_e_step4_rfc:'Tax Registration Certificate (RFC)',onb_e_step4_id:'Official ID / Articles of Incorporation',onb_e_step4_address:'Proof of address (< 3 months)',onb_e_step4_upload:'Choose file',onb_e_step4_uploading:'Uploading...',onb_e_step4_done:'File uploaded',onb_e_step4_error:'Upload error',onb_e_step4_formats:'PDF or image, max 5 MB',
    onb_e_step5_h:'Create your<br><em>account</em>.',onb_e_step5_sub:'One last step to activate VIDA for your company.',onb_e_step5_pass:'Password',onb_e_step5_pass_ph:'Min 6 characters',onb_e_step5_terms:'I accept the',onb_e_step5_terms_link:'Terms and Conditions',onb_e_step5_btn:'Create My Account',onb_e_step5_creating:'Creating account...',
    onb_e_step6_h:'Account<br><em>created</em>!',onb_e_step6_sub:'Our team will review your documents within 24–48 business hours.',onb_e_step6_badge:'Verification in progress',onb_e_step6_cta:'Go to home',
    dash_doc_banner_h:'Complete Your Verification',dash_doc_banner_sub:'Upload the required documents so we can activate your account within 24–48 hours.',dash_doc_banner_success:'Documents submitted! We\'ll review them within 24–48 hours.',
    onb_m_step1_h:'Enter your<br><em>code</em>.',onb_m_step1_sub:'Your employer provided you with an access code.',onb_m_step1_placeholder:'CODE',onb_m_step1_hint:'Don\'t have a code? Ask your HR department.',onb_m_step1_found:'Company found',onb_m_step1_not_found:'Code not found',onb_m_step1_searching:'Searching...',
    onb_m_step2_h:'Tell us<br>about <em>you</em>.',onb_m_step2_sub:'Your personal information to activate your credit.',onb_m_step2_name:'Full name',onb_m_step2_name_ph:'Your full name',onb_m_step2_email:'Email address',onb_m_step2_email_ph:'you@email.com',
    onb_m_step3_h:'Your<br><em>pre-approved</em> credit.',onb_m_step3_sub:'Enter your monthly salary to see your credit line.',onb_m_step3_salary:'Monthly salary',onb_m_step3_salary_ph:'15,000',onb_m_step3_preapproved:'Pre-approved',onb_m_step3_credit_label:'AVAILABLE CREDIT',
    onb_m_step4_h:'Create your<br><em>account</em>.',onb_m_step4_sub:'One last step to access your credit.',onb_m_step4_pass:'Password',onb_m_step4_pass_ph:'Min 6 characters',onb_m_step4_terms:'I accept the',onb_m_step4_terms_link:'Terms and Conditions',onb_m_step4_btn:'Activate My Credit',onb_m_step4_creating:'Activating...',
    onb_m_step5_h:'Credit<br><em>approved</em>!',onb_m_step5_sub:'Your credit line is ready to use.',onb_m_step5_tag:'PRE-APPROVED',onb_m_step5_cta:'Access My Credit',
    onb_strength_weak:'Weak',onb_strength_medium:'Medium',onb_strength_strong:'Strong',
    // Employer Landing
    lp_e_badge:'For Employers',
    lp_e_h1:'Financial wellness<br>for your <em>team</em>.',
    lp_e_sub:'Give your employees access to emergency credit via payroll. Zero risk for your company. Zero operational burden. Measurable retention impact.',
    lp_e_cta:'Register My Company',
    lp_e_login:'Already have an account?',
    lp_e_why_tag:'Why VIDA',
    lp_e_why_h:'Your team deserves<br>a safety <em>net</em>.',
    lp_e_why_p:'78% of employees in Mexico live paycheck to paycheck. Financial stress reduces productivity, increases absenteeism, and drives turnover. VIDA solves this.',
    lp_e_why_1_v:'78%',lp_e_why_1_l:'of employees live paycheck to paycheck',
    lp_e_why_2_v:'3.2×',lp_e_why_2_l:'more productive with financial stability',
    lp_e_why_3_v:'41%',lp_e_why_3_l:'reduction in voluntary turnover',
    lp_e_why_4_v:'$0',lp_e_why_4_l:'cost to your company',
    lp_e_how_tag:'How it works',
    lp_e_how_h:'Integration in<br><em>minutes</em>, not months.',
    lp_e_how_1_t:'Sign up in 2 minutes',lp_e_how_1_d:'Create your account, enter your company details, and receive a unique code.',
    lp_e_how_2_t:'Share the code',lp_e_how_2_d:'Send the code to your employees. They sign up on their own.',
    lp_e_how_3_t:'Your employees get access',lp_e_how_3_d:'Pre-approved credit up to $5,000 MXN. Funds within 24 hours.',
    lp_e_how_4_t:'Automatic deduction',lp_e_how_4_d:'Repayments deducted from payroll. Zero manual management.',
    lp_e_ben_tag:'Benefits',
    lp_e_ben_h:'Zero risk.<br><em>Maximum</em> impact.',
    lp_e_ben_1_t:'No financial liability',lp_e_ben_1_d:'VIDA assumes 100% of credit risk. Your company does not guarantee or back the loans.',
    lp_e_ben_2_t:'Measurable retention',lp_e_ben_2_d:'Companies with VIDA report up to 41% less turnover in the first 6 months.',
    lp_e_ben_3_t:'Universal integration',lp_e_ben_3_d:'Compatible with Nomipaq, Aspel NOI, CONTPAQi, Workday, ADP, and any payroll system.',
    lp_e_ben_4_t:'Institutional governance',lp_e_ben_4_d:'Swiss holding. SOFOM registered in Mexico. Bank-grade encryption. Transparent pricing.',
    lp_e_close_h:'Empower your team<br><em>today</em>.',
    lp_e_close_sub:'Sign up in 2 minutes. No long contracts. No commitments.',
    // Employee Landing
    lp_m_badge:'For Employees',
    lp_m_h1:'Your financial<br><em>safety</em><br>net.',
    lp_m_sub:'Access pre-approved emergency credit through your employer. No credit checks. No paperwork. Funds within 24 hours.',
    lp_m_cta:'Activate My Credit',
    lp_m_no_code:'Your company doesn\'t have VIDA yet?',
    lp_m_no_code_link:'Tell them how to activate it',
    lp_m_what_tag:'What you get',
    lp_m_what_h:'Emergency credit,<br><em>already approved</em>.',
    lp_m_what_1_v:'$5,000',lp_m_what_1_l:'Maximum available credit',
    lp_m_what_2_v:'24 hrs',lp_m_what_2_l:'Funds in your account',
    lp_m_what_3_v:'$0',lp_m_what_3_l:'Hidden fees',
    lp_m_what_4_v:'Payroll',lp_m_what_4_l:'Automatic deduction',
    lp_m_widget_tag:'Your credit',
    lp_m_widget_h:'Simulate your<br>credit <em>line</em>.',
    lp_m_widget_sub:'Enter your monthly salary and discover how much you can access. Your credit is automatically calculated as 30% of your salary, up to a maximum of $5,000 MXN.',
    lp_m_widget_salary:'Monthly salary',
    lp_m_widget_salary_ph:'15,000',
    lp_m_widget_available:'Available credit',
    lp_m_widget_rate:'Fee',
    lp_m_widget_rate_val:'30% monthly',
    lp_m_widget_term:'Term',
    lp_m_widget_term_val:'30 days',
    lp_m_widget_repayment:'Total repayment',
    lp_m_widget_deduction:'Payroll deduction',
    lp_m_widget_disbursement:'Disbursement',
    lp_m_widget_disbursement_val:'Within 24 hours',
    lp_m_widget_preapproved:'Pre-approved',
    lp_m_widget_no_check:'No credit check',
    lp_m_widget_no_paperwork:'No paperwork',
    lp_m_widget_cta:'Activate My Credit',
    lp_m_how_tag:'How it works',
    lp_m_how_h:'Three steps.<br><em>Zero</em> complications.',
    lp_m_how_1_t:'Get your code',lp_m_how_1_d:'Your employer will provide you with an access code. If you don\'t have one, ask HR.',
    lp_m_how_2_t:'Create your account',lp_m_how_2_d:'Sign up with your code. Enter your salary and discover your credit line.',
    lp_m_how_3_t:'Request funds',lp_m_how_3_d:'Choose the amount and term. Receive funds within 24 hours. Payments are deducted from your payroll.',
    lp_m_use_tag:'Use it when you need it',
    lp_m_use_h:'Life doesn\'t wait.<br><em>Neither does VIDA</em>.',
    lp_m_use_1_t:'Medical emergencies',lp_m_use_1_d:'Hospital visits, urgent prescriptions, unexpected treatments.',
    lp_m_use_2_t:'Urgent repairs',lp_m_use_2_d:'Car, home, appliances. What can\'t wait.',
    lp_m_use_3_t:'Family support',lp_m_use_3_d:'When your loved ones need you, you need liquidity.',
    lp_m_use_4_t:'Unexpected expenses',lp_m_use_4_d:'Bills that arrive without warning. Opportunities that require action.',
    lp_m_ask_tag:'Your company doesn\'t have VIDA?',
    lp_m_ask_h:'Tell your employer<br>to activate <em>VIDA</em>.',
    lp_m_ask_sub:'Many employers don\'t know about VIDA yet. You can help activate it for you and all your colleagues.',
    lp_m_ask_1_t:'Talk to HR',lp_m_ask_1_d:'Mention VIDA in your next conversation with Human Resources. It\'s free for the company.',
    lp_m_ask_2_t:'Share the link',lp_m_ask_2_d:'Send vidacard.mx/hr to your boss or HR department.',
    lp_m_ask_3_t:'We contact them',lp_m_ask_3_d:'If you prefer, give us your company\'s contact and we\'ll reach out directly.',
    lp_m_close_h:'Your financial wellness<br>starts <em>today</em>.',
    lp_m_close_sub:'If your company already has VIDA, activate your credit in 2 minutes.',
    lp_m_close_cta:'Activate My Credit',
    lp_m_close_cta2:'My Company Doesn\'t Have VIDA',
    // About
    pg_about_badge:'Our Story',
    pg_about_h1:'Building financial<br><em>resilience</em>.',
    pg_about_sub:'VIDA was born from a simple mission: no one should lose stability due to an unexpected financial emergency.',
    pg_about_mission_tag:'Mission',
    pg_about_mission_h:'Democratizing access<br>to emergency <em>credit</em>.',
    pg_about_mission_p:'In Mexico, 78% of formal workers live paycheck to paycheck. A medical emergency, an urgent repair, or an unexpected family expense can destabilize months of progress. VIDA exists to solve this problem, connecting payroll infrastructure with responsible, accessible credit.',
    pg_about_struct_tag:'Structure',
    pg_about_struct_h:'Swiss governance.<br>Mexican <em>operation</em>.',
    pg_about_struct_1_t:'VIDA Holding AG',pg_about_struct_1_d:'Corporate holding under Swiss financial regulation. Based in Zurich. Governance, compliance, and strategic oversight.',
    pg_about_struct_2_t:'VIDA Finance SOFOM',pg_about_struct_2_d:'Financial entity registered with CONDUSEF in Mexico. Credit operations, customer service, and employer relations.',
    pg_about_struct_3_t:'Technology Infrastructure',pg_about_struct_3_d:'Proprietary platform built with end-to-end bank-grade encryption. Direct integration with payroll systems.',
    pg_about_values_tag:'Values',
    pg_about_values_h:'The principles that <em>guide</em> us.',
    pg_about_val_1_t:'Radical transparency',pg_about_val_1_d:'No hidden fees. No fine print. Every cost visible before signing.',
    pg_about_val_2_t:'Responsibility first',pg_about_val_2_d:'Conservative credit limits. We never lend more than you can comfortably repay.',
    pg_about_val_3_t:'Absolute privacy',pg_about_val_3_d:'Your employer never sees your individual loans. Your financial information is yours.',
    pg_about_val_4_t:'Measurable impact',pg_about_val_4_d:'Every product decision is measured by its real impact on employees\' lives.',
    // Security
    pg_sec_badge:'Security',
    pg_sec_h1:'Your security is<br>our <em>priority</em>.',
    pg_sec_sub:'We protect your data with the same standards used by the world\'s most demanding financial institutions.',
    pg_sec_enc_tag:'Encryption',
    pg_sec_enc_h:'Bank-grade<br><em>protection</em>.',
    pg_sec_enc_1_t:'TLS 1.3 in transit',pg_sec_enc_1_d:'All communication between your device and our servers is encrypted with the most advanced protocol available.',
    pg_sec_enc_2_t:'AES-256 at rest',pg_sec_enc_2_d:'Your stored data is protected with the same encryption standard used by the U.S. government for classified information.',
    pg_sec_enc_3_t:'Irreversible hashing',pg_sec_enc_3_d:'Passwords are never stored. They\'re transformed with bcrypt, making them irrecoverable even for us.',
    pg_sec_enc_4_t:'Ephemeral tokens',pg_sec_enc_4_d:'Sessions use short-lived tokens that are automatically renewed and invalidated on logout.',
    pg_sec_infra_tag:'Infrastructure',
    pg_sec_infra_h:'Enterprise-grade<br><em>infrastructure</em>.',
    pg_sec_infra_p:'Our platform operates on world-class enterprise cloud infrastructure, hosted in data centers certified SOC 1, SOC 2 & SOC 3, ISO 27001, with geographic redundancy, automatic backups, built-in DDoS protection, and continuous security audits by independent third parties.',
    pg_sec_infra_1_v:'99.95%',pg_sec_infra_1_l:'Guaranteed uptime (SLA)',
    pg_sec_infra_2_v:'SOC 2',pg_sec_infra_2_l:'Type II certified',
    pg_sec_infra_3_v:'ISO 27001',pg_sec_infra_3_l:'Information security management',
    pg_sec_infra_4_v:'GDPR',pg_sec_infra_4_l:'European regulatory compliance',
    pg_sec_infra_5_v:'DDoS',pg_sec_infra_5_l:'Automatic attack protection',
    pg_sec_infra_6_v:'24/7',pg_sec_infra_6_l:'Continuous infrastructure monitoring',
    pg_sec_practices_tag:'Practices',
    pg_sec_practices_h:'Security at every <em>layer</em>.',
    pg_sec_pr_1_t:'Multi-factor authentication',pg_sec_pr_1_d:'Two-step verification available for all employer accounts.',
    pg_sec_pr_2_t:'24/7 monitoring',pg_sec_pr_2_d:'Intrusion detection and anomaly systems operating continuously.',
    pg_sec_pr_3_t:'Least privilege principle',pg_sec_pr_3_d:'Each internal service only accesses the data strictly necessary for its function.',
    pg_sec_pr_4_t:'Regular audits',pg_sec_pr_4_d:'Penetration tests and security reviews conducted by independent third parties.',
    // Privacy Policy
    pg_priv_badge:'Legal',
    pg_priv_h1:'Privacy<br><em>Policy</em>.',
    pg_priv_updated:'Last updated: January 1, 2025',
    pg_priv_intro:'At VIDA Finance ("VIDA", "we"), we are committed to protecting your personal information. This Privacy Policy describes how we collect, use, store, and protect your data when you use our platform.',
    pg_priv_1_t:'1. Information we collect',
    pg_priv_1_p:'We collect information you provide directly when creating your account: full name, email address, company name (employers), employer code (employees), declared monthly salary (employees), and encrypted password. We also collect usage data such as IP address, browser type, pages visited, and timestamps.',
    pg_priv_2_t:'2. How we use your information',
    pg_priv_2_p:'We use your information to: process and manage credit requests, verify your identity and eligibility, communicate with you about your account and loans, improve our services and user experience, comply with legal and regulatory obligations, and prevent fraud and unauthorized activities.',
    pg_priv_3_t:'3. Data sharing',
    pg_priv_3_p:'We do not sell your personal information. We share limited data with: your employer (registration confirmation only, never individual loan details), certified cloud infrastructure providers that help us operate the platform securely, and regulatory authorities when required by law.',
    pg_priv_4_t:'4. Data security',
    pg_priv_4_p:'We protect your information with TLS 1.3 encryption in transit, AES-256 at rest, irreversible password hashing, role-based access control, and continuous security monitoring. For more details, see our Security page.',
    pg_priv_5_t:'5. Data retention',
    pg_priv_5_p:'We retain your personal information while you maintain an active account and for the period required by Mexican financial regulations (minimum 10 years for transaction records). You may request account deletion at any time, subject to legal retention obligations.',
    pg_priv_6_t:'6. Your rights',
    pg_priv_6_p:'Under the Federal Law on Protection of Personal Data Held by Private Parties (LFPDPPP), you have the right to: access your personal data, rectify inaccurate data, cancel data processing, oppose the use of your data (ARCO rights). To exercise these rights, contact privacidad@vidacard.mx.',
    pg_priv_7_t:'7. Cookies and similar technologies',
    pg_priv_7_p:'We use essential cookies for platform operation, preference cookies to remember your language and session, and analytics tools to improve our services. We do not use third-party advertising cookies.',
    pg_priv_8_t:'8. Contact',
    pg_priv_8_p:'For questions about this policy, contact our Data Protection Officer at privacidad@vidacard.mx or write to us at VIDA Finance, Mexico City, Mexico.',
    // Terms
    pg_terms_badge:'Legal',
    pg_terms_h1:'Terms of<br><em>Service</em>.',
    pg_terms_updated:'Last updated: January 1, 2025',
    pg_terms_intro:'These Terms of Service ("Terms") govern the use of the VIDA Finance platform ("VIDA", "the Platform"). By creating an account or using our services, you accept these Terms in their entirety.',
    pg_terms_1_t:'1. Definitions',
    pg_terms_1_p:'"Employer" refers to the registered company offering VIDA as a benefit. "Employee" refers to the worker accessing credit through their registered employer. "Credit" refers to the short-term loan granted to the Employee. "Employer Code" is the unique identifier assigned to each Employer to link their Employees.',
    pg_terms_2_t:'2. Eligibility',
    pg_terms_2_p:'To use the Platform as an Employer, you must be a legally incorporated company in Mexico with at least one active employee. As an Employee, you must have a valid Employer Code, be over 18 years old, and have an active employment relationship with a registered Employer.',
    pg_terms_3_t:'3. Credits and conditions',
    pg_terms_3_p:'Credits have a maximum limit of $5,000 MXN, calculated based on declared monthly salary (up to 30% of salary). The term is 30 days with a fee of 30% on the requested amount. There are no hidden fees, early payment penalties, or additional charges. Payments are automatically deducted from the Employee\'s payroll.',
    pg_terms_4_t:'4. Employer obligations',
    pg_terms_4_p:'The Employer commits to: providing truthful company information, facilitating payroll deduction for credit payments, not discriminating against employees who use VIDA, and maintaining platform information confidential. The Employer assumes no financial liability for credits granted to their employees.',
    pg_terms_5_t:'5. Employee obligations',
    pg_terms_5_p:'The Employee commits to: providing truthful personal information, authorizing automatic payroll deduction, notifying changes in employment status, not sharing access credentials, and using funds responsibly.',
    pg_terms_6_t:'6. Intellectual property',
    pg_terms_6_p:'All Platform content, including design, texts, logos, source code, and the VIDA brand, is the property of VIDA Holding AG and is protected by intellectual property laws. Reproduction without written authorization is prohibited.',
    pg_terms_7_t:'7. Limitation of liability',
    pg_terms_7_p:'VIDA shall not be liable for: temporary service interruptions, financial decisions made by users, changes in the Employee\'s employment status, or indirect damages arising from Platform use. VIDA reserves the right to modify, suspend, or discontinue any aspect of the service.',
    pg_terms_8_t:'8. Applicable law',
    pg_terms_8_p:'These Terms are governed by the laws of the United Mexican States. Any dispute shall be resolved before the competent courts of Mexico City. For legal inquiries, contact legal@vidacard.mx.',
    // Partners
    pg_part_badge:'Partner Program',
    pg_part_h1:'Grow with<br><em>VIDA</em>.',
    pg_part_sub:'Join our partner ecosystem and bring financial wellness to thousands of employees in Mexico.',
    pg_part_cta:'Apply as Partner',
    pg_part_who_tag:'For whom',
    pg_part_who_h:'Designed for those who<br>already talk to <em>companies</em>.',
    pg_part_who_1_t:'HR Consultants',pg_part_who_1_d:'Offer VIDA as part of your employee benefits portfolio.',
    pg_part_who_2_t:'Payroll Providers',pg_part_who_2_d:'Integrate VIDA directly into your payroll platform and add value for your clients.',
    pg_part_who_3_t:'Insurance Brokers',pg_part_who_3_d:'Complement your financial protection offering with emergency credit.',
    pg_part_who_4_t:'Business Associations',pg_part_who_4_d:'Bring a tangible benefit to members of your chamber or association.',
    pg_part_how_tag:'How it works',
    pg_part_how_h:'Three steps to<br>become a <em>partner</em>.',
    pg_part_how_1_t:'Apply',pg_part_how_1_d:'Complete the application form. Our team will review your profile within 48 hours.',
    pg_part_how_2_t:'Integrate',pg_part_how_2_d:'Receive materials, training, and your personalized referral link.',
    pg_part_how_3_t:'Earn',pg_part_how_3_d:'Recurring commission for each active employer you refer to VIDA.',
    pg_part_ben_tag:'Benefits',
    pg_part_ben_h:'A partnership that<br><em>works</em>.',
    pg_part_ben_1_v:'15%',pg_part_ben_1_l:'Recurring commission on revenue generated',
    pg_part_ben_2_v:'$0',pg_part_ben_2_l:'Integration or membership cost',
    pg_part_ben_3_v:'24/7',pg_part_ben_3_l:'Dedicated partner support',
    pg_part_ben_4_v:'∞',pg_part_ben_4_l:'No referral limit',
    // Investors
    pg_inv_badge:'Investors',
    pg_inv_h1:'The payroll credit<br><em>opportunity</em>.',
    pg_inv_sub:'A $23B underserved market in Mexico. Regulated infrastructure. Proven business model. Swiss governance.',
    pg_inv_market_tag:'Market',
    pg_inv_market_h:'A massive<br><em>underserved</em> market.',
    pg_inv_market_p:'55 million formal workers in Mexico. 78% without access to responsible emergency credit. Existing alternatives charge rates exceeding 400% annually.',
    pg_inv_market_1_v:'$23B',pg_inv_market_1_l:'Total addressable market',
    pg_inv_market_2_v:'55M',pg_inv_market_2_l:'Formal workers in Mexico',
    pg_inv_market_3_v:'78%',pg_inv_market_3_l:'Without access to formal credit',
    pg_inv_market_4_v:'<2%',pg_inv_market_4_l:'Current EWA penetration in Mexico',
    pg_inv_model_tag:'Model',
    pg_inv_model_h:'Proven unit<br><em>economics</em>.',
    pg_inv_model_1_t:'Employer-driven acquisition',pg_inv_model_1_d:'One integrated employer = access to hundreds of employees. CAC per employee near $0.',
    pg_inv_model_2_t:'Payroll deduction',pg_inv_model_2_d:'Default rate below 2% thanks to automatic payroll deduction.',
    pg_inv_model_3_t:'Recurring revenue',pg_inv_model_3_d:'Transaction fees with high recurrence. Employees request credit an average of 3.2 times per year.',
    pg_inv_model_4_t:'Regulated scalability',pg_inv_model_4_d:'SOFOM license enables scaling operations without requiring a full banking license.',
    pg_inv_gov_tag:'Governance',
    pg_inv_gov_h:'Institutional structure<br>from <em>day one</em>.',
    pg_inv_gov_p:'VIDA Holding AG in Switzerland. VIDA Finance SOFOM in Mexico. Independent board of directors. Quarterly audits. Full regulatory compliance.',
    pg_inv_cta:'Request Investor Deck',
    pg_inv_cta_email:'investor.relations@vidacard.mx',
    // Contact
    pg_contact_badge:'Contact',
    pg_contact_h1:'Let\'s talk<br>about <em>VIDA</em>.',
    pg_contact_sub:'We\'re here to answer your questions, explore partnerships, or simply chat.',
    pg_contact_general_t:'General inquiries',pg_contact_general_v:'hola@vidacard.mx',
    pg_contact_employers_t:'Employers',pg_contact_employers_v:'empresas@vidacard.mx',
    pg_contact_press_t:'Press',pg_contact_press_v:'prensa@vidacard.mx',
    pg_contact_investors_t:'Investors',pg_contact_investors_v:'investor.relations@vidacard.mx',
    pg_contact_privacy_t:'Privacy',pg_contact_privacy_v:'privacidad@vidacard.mx',
    pg_contact_office_tag:'Offices',
    pg_contact_office_mx_t:'Mexico City',pg_contact_office_mx_d:'Av. Paseo de la Reforma 250, Floor 12<br>Col. Juárez, 06600 CDMX, Mexico',
    pg_contact_office_ch_t:'Zurich',pg_contact_office_ch_d:'Bahnhofstrasse 42<br>8001 Zurich, Switzerland',
    pg_contact_form_name:'Name',pg_contact_form_name_ph:'Your name',
    pg_contact_form_email:'Email',pg_contact_form_email_ph:'you@email.com',
    pg_contact_form_type:'Inquiry type',
    pg_contact_form_type_general:'General inquiry',pg_contact_form_type_employer:'I\'m an employer',pg_contact_form_type_partner:'I want to be a partner',pg_contact_form_type_investor:'I\'m an investor',pg_contact_form_type_press:'Press',pg_contact_form_type_other:'Other',
    pg_contact_form_msg:'Message',pg_contact_form_msg_ph:'How can we help you?',
    pg_contact_form_send:'Send Message',pg_contact_form_sent:'Message sent! We\'ll get back to you soon.',
    // Press
    pg_press_badge:'Press',
    pg_press_h1:'VIDA in the<br><em>media</em>.',
    pg_press_sub:'Resources, data, and materials for journalists and researchers.',
    pg_press_kit_tag:'Press Kit',
    pg_press_kit_h:'Everything you need<br>to cover <em>VIDA</em>.',
    pg_press_kit_1_t:'About VIDA',pg_press_kit_1_d:'VIDA is an employer-enabled emergency credit platform. It allows employees of registered companies to access loans of up to $5,000 MXN with automatic payroll deduction, no credit checks, and funds within 24 hours.',
    pg_press_kit_2_t:'Key data',pg_press_kit_2_d:'Founded in 2024. Holding in Switzerland (VIDA Holding AG). Operations in Mexico (VIDA Finance SOFOM). Credits from $500 to $5,000 MXN. 30-day term. 30% monthly fee. No hidden fees.',
    pg_press_kit_3_t:'The problem we solve',pg_press_kit_3_d:'78% of formal workers in Mexico live paycheck to paycheck. Informal credit alternatives charge rates exceeding 400% annually. VIDA offers responsible credit through the employer\'s payroll infrastructure.',
    pg_press_contact_tag:'Press Contact',
    pg_press_contact_p:'For interviews, data, or additional information:',
    pg_press_contact_email:'prensa@vidacard.mx',
    pg_press_brand_tag:'Brand',
    pg_press_brand_h:'Brand <em>guidelines</em>.',
    pg_press_brand_1_t:'Name',pg_press_brand_1_d:'VIDA — always in capitals. The full name is "VIDA Finance" for formal contexts.',
    pg_press_brand_2_t:'Primary color',pg_press_brand_2_d:'Dark teal #194445 — used in the logo, main text, and brand elements.',
    pg_press_brand_3_t:'Accent color',pg_press_brand_3_d:'Gold #C9A84C — used as a signal color, never as background. Reserved for highlighting key data.',
    pg_press_brand_4_t:'Typography',pg_press_brand_4_d:'DM Serif Display for headlines. DM Sans for body text. Both from Google Fonts.',
    // Ops Dashboard
    ops_title:'VIDA OPS',ops_signout:'Sign out',
    ops_nav_review:'Review Queue',ops_nav_portfolio:'Portfolio',ops_nav_employers:'Employers',ops_nav_alerts:'Alerts',
    // Review Queue
    ops_rq_title:'Manual Review Queue',ops_rq_empty:'No pending reviews',
    ops_rq_sort_risk:'Risk',ops_rq_sort_sla:'SLA',ops_rq_sort_confidence:'Confidence',
    ops_rq_sla_label:'SLA',ops_rq_sla_expired:'Expired',
    ops_rq_col_applicant:'Applicant',ops_rq_col_amount:'Amount',ops_rq_col_risk:'Risk Level',ops_rq_col_confidence:'Confidence',ops_rq_col_sla:'SLA Time',ops_rq_col_status:'Status',ops_rq_col_actions:'Actions',
    ops_rq_risk_high:'High',ops_rq_risk_medium:'Medium',ops_rq_risk_low:'Low',
    ops_rq_btn_approve:'Approve',ops_rq_btn_reject:'Reject',ops_rq_btn_info:'Request Info',
    ops_rq_detail_narrative:'LLM Risk Narrative',ops_rq_detail_signals:'Signals (Stages 0-4)',ops_rq_detail_shap:'SHAP Top-5 Features',
    ops_rq_notes_placeholder:'Analyst notes...',ops_rq_confirm:'Confirm',
    ops_rq_toast_approved:'Review approved',ops_rq_toast_rejected:'Review rejected',ops_rq_toast_info:'Additional information requested',
    // Portfolio
    ops_pf_title:'Portfolio Dashboard',
    ops_pf_active_size:'Active Portfolio',ops_pf_outstanding:'Total Outstanding',ops_pf_default_rate:'Default Rate',ops_pf_trend:'Trend',
    ops_pf_by_status:'Loans by Status',ops_pf_by_employer:'Employer Aggregation',
    ops_pf_col_employer:'Employer',ops_pf_col_loans:'Loans',ops_pf_col_outstanding:'Outstanding',ops_pf_col_compliance:'Deduction Compliance',
    ops_pf_cohort:'Cohort Analysis',ops_pf_cohort_month:'Origination Month',ops_pf_cohort_count:'Loans',ops_pf_cohort_default:'Default Rate',
    ops_pf_status_pending:'Pending',ops_pf_status_active:'Active',ops_pf_status_overdue:'Overdue',ops_pf_status_paid:'Paid',ops_pf_status_defaulted:'Defaulted',
    // Employer Management
    ops_em_title:'Employer Management',ops_em_empty:'No employers',
    ops_em_col_company:'Company',ops_em_col_tier:'Tier',ops_em_col_score:'Score',ops_em_col_slots:'Active Slots',ops_em_col_employees:'Employees',ops_em_col_actions:'Actions',
    ops_em_btn_expand:'Expand Slots',ops_em_btn_upgrade:'Upgrade to Tier 1',ops_em_btn_history:'History',
    ops_em_expand_title:'Expand slots',ops_em_expand_placeholder:'New slots',ops_em_expand_confirm:'Confirm',
    ops_em_toast_expanded:'Slots expanded',ops_em_toast_upgraded:'Employer upgraded to Tier 1',
    ops_em_screening:'Screening History',ops_em_screening_empty:'No history',
    // Alerts
    ops_al_title:'System Health Dashboard',ops_al_empty:'No health data',
    ops_al_services:'Services',ops_al_queues:'Queue Depths',ops_al_drift:'Drift Indicators',
    ops_al_col_service:'Service',ops_al_col_status:'Status',ops_al_col_latency:'Latency',ops_al_col_checked:'Last Check',
    ops_al_col_queue:'Queue',ops_al_col_waiting:'Waiting',ops_al_col_active:'Active',ops_al_col_failed:'Failed',ops_al_col_completed:'Completed',
    ops_al_status_ok:'Operational',ops_al_status_degraded:'Degraded',ops_al_status_down:'Down',
    ops_al_drift_psi:'PSI (Population Stability)',ops_al_drift_csi:'CSI (Characteristic Stability)',ops_al_drift_status:'Status',ops_al_drift_ok:'Normal',ops_al_drift_warning:'Warning',ops_al_drift_alert:'Alert',
  }
};

let currentLang = localStorage.getItem('vida_lang') || 'es';
function t(key) { return (i18n[currentLang] && i18n[currentLang][key]) || (i18n.es[key]) || key; }
function setLang(lang) { currentLang = lang; localStorage.setItem('vida_lang', lang); document.documentElement.lang = lang; router(); }
function toggleLang() { setLang(currentLang === 'es' ? 'en' : 'es'); }

// ─── Animated Logo ───────────────────────────────────────
function vidaLogo(cls) {
  const c = cls === 'ft' ? 'rgba(255,255,255,0.7)' : '#1c4b4a';
  return `<span class="vida-logo ${cls||''}" aria-label="VIDA">` +
    `<svg class="vida-logo-full" viewBox="0 0 920 282" xmlns="http://www.w3.org/2000/svg">` +
      `<g class="vida-logo-v">` +
        `<path fill="${c}" d="M0,0h44l78,203L199,0h44L136,281H107Z"/>` +
      `</g>` +
      `<g class="vida-logo-ida">` +
        `<rect fill="${c}" x="295" y="0" width="41" height="281"/>` +
        `<rect fill="${c}" x="400" y="0" width="41" height="281"/>` +
        `<path fill="${c}" d="M491,0c78,0,141,63,141,140s-63,141-141,141H441v-41h50c55,0,99-45,99-100s-45-99-99-99H441V0h50Z"/>` +
        `<path fill="${c}" d="M770,0h29L906,281H862L785,78,707,281H663L770,0Z"/>` +
      `</g>` +
    `</svg>` +
  `</span>`;
}

// ─── SPA Router ──────────────────────────────────────────
const routes = {
  '/': renderHome,
  '/login': renderLogin,
  '/signup': renderOnboarding,
  '/onboarding': renderOnboarding,
  '/employers': renderEmployerLanding,
  '/employees': renderEmployeeLanding,
  '/about': renderAbout,
  '/security': renderSecurity,
  '/privacy': renderPrivacy,
  '/terms': renderTerms,
  '/partners': renderPartners,
  '/investors': renderInvestors,
  '/contact': renderContact,
  '/press': renderPress,
  '/employer/dashboard': renderEmployerDashboard,
  '/employer/employees': (app) => renderEmployerHR(app, 'employees'),
  '/employer/deductions': (app) => renderEmployerHR(app, 'deductions'),
  '/employer/onboarding': (app) => renderEmployerHR(app, 'onboarding'),
  '/employer/analytics': (app) => renderEmployerHR(app, 'analytics'),
  '/employee/dashboard': renderEmployeeDashboard,
  '/admin':            (app) => renderAdminPortal(app, 'employers'),
  '/admin/employers':  (app) => renderAdminPortal(app, 'employers'),
  '/admin/loans':      (app) => renderAdminPortal(app, 'loans'),
  '/admin/finance':    (app) => renderAdminPortal(app, 'finance'),
  '/ops':              (app) => renderOpsPortal(app, 'review-queue'),
  '/ops/review-queue': (app) => renderOpsPortal(app, 'review-queue'),
  '/ops/portfolio':    (app) => renderOpsPortal(app, 'portfolio'),
  '/ops/employers':    (app) => renderOpsPortal(app, 'employers'),
  '/ops/alerts':       (app) => renderOpsPortal(app, 'alerts'),
  '/admin/audit':      (app) => renderAdminPortal(app, 'audit'),
};

let onbPreselect = null;

function navigate(path, opts) {
  if (window._unsubDash) { window._unsubDash(); window._unsubDash = null; }
  if (window._unsubEmp) { window._unsubEmp(); window._unsubEmp = null; }
  if (window._adminUnsubs) { window._adminUnsubs.forEach(u => u()); window._adminUnsubs = null; }
  if (opts?.role) onbPreselect = opts.role;
  history.pushState(null, '', path);
  router();
}

window.addEventListener('popstate', router);

async function router() {
  const path = location.pathname;
  const app = document.getElementById('app');
  const handler = routes[path];
  if (path.startsWith('/employer/') && !auth.currentUser) { navigate('/login'); return; }
  if (path.startsWith('/employee/') && !auth.currentUser) { navigate('/login'); return; }
  if (path.startsWith('/admin')) {
    const user = auth.currentUser;
    if (!user) { navigate('/login'); return; }
    try {
      const tok = await user.getIdTokenResult(true);
      if (!tok.claims.admin) { navigate('/'); return; }
    } catch (_) { navigate('/'); return; }
  }
  if (path.startsWith('/ops')) {
    const user = auth.currentUser;
    if (!user) { navigate('/login'); return; }
    try {
      const tok = await user.getIdTokenResult(true);
      const role = tok.claims.role;
      if (!['ops', 'admin', 'super_admin'].includes(role) && !tok.claims.admin) { navigate('/'); return; }
    } catch (_) { navigate('/'); return; }
  }
  if (handler) { handler(app); } else { renderHome(app); }
}

auth.onAuthStateChanged(async (user) => {
  if (user) {
    const path = location.pathname;
    if (path === '/login' || path === '/signup' || path === '/onboarding') {
      const tok = await user.getIdTokenResult();
      if (tok.claims.admin || tok.claims.role === 'admin' || tok.claims.role === 'super_admin') { navigate('/admin'); return; }
      if (tok.claims.role === 'ops') { navigate('/ops'); return; }
      const doc = await db.collection('employers').doc(user.uid).get();
      navigate(doc.exists ? '/employer/dashboard' : '/employee/dashboard');
    }
  }
  if (!document.getElementById('app').innerHTML) router();
});

// ─── Helpers ─────────────────────────────────────────────
function showToast(msg, type = '') {
  let toast = document.getElementById('toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; toast.className = 'toast'; document.body.appendChild(toast); }
  toast.textContent = msg; toast.className = 'toast ' + type;
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.classList.remove('show'), 3000);
}
function fmt(n) { return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function parseMoney(s) { return parseInt(String(s).replace(/[^0-9]/g, '')) || 0; }
function renderDocLinks(l) {
  let h = '';
  if (l.contractUrl) h += `<a href="${l.contractUrl}" target="_blank" rel="noopener" class="doc-link">${t('dash_doc_contract')}</a>`;
  if (l.receiptUrl && l.status === 'paid') h += `<a href="${l.receiptUrl}" target="_blank" rel="noopener" class="doc-link">${t('dash_doc_receipt')}</a>`;
  if (!l.contractUrl && l.status !== 'pending') h += `<span style="color:var(--t3);font-size:11px">${t('dash_doc_generating')}</span>`;
  return h || '—';
}

function fireConfetti() {
  const colors = ['#c9a84c','#a8d5d0','#247a6e','#fff','#dceeed'];
  for (let i = 0; i < 60; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.top = '-10px';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.width = (Math.random() * 8 + 4) + 'px';
    el.style.height = (Math.random() * 8 + 4) + 'px';
    el.style.animationDuration = (Math.random() * 2 + 2) + 's';
    el.style.animationDelay = (Math.random() * 0.8) + 's';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

function countUp(el, target, duration = 1200) {
  let start = 0;
  const step = (ts) => {
    if (!start) start = ts;
    const p = Math.min((ts - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    const val = Math.round(ease * target);
    el.innerHTML = '<span class="onb-cur">$</span>' + fmt(val);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function passwordStrength(pw) {
  if (!pw || pw.length < 6) return 'weak';
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score >= 3 ? 'strong' : score >= 1 ? 'medium' : 'weak';
}

// ─── ONBOARDING ──────────────────────────────────────────
function renderOnboarding(app) {
  const state = { step: 0, role: onbPreselect || null, data: {}, employerDoc: null };
  onbPreselect = null;

  const totalSteps = { employer: 5, employee: 5 };
  const backArrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';

  function progress() {
    if (!state.role) return 0;
    return (state.step / totalSteps[state.role]) * 100;
  }

  function shell() {
    return `
<div class="onb">
  <div class="onb-blob ob1"></div><div class="onb-blob ob2"></div>
  <div class="onb-top">
    <span class="onb-logo">${vidaLogo()}</span>
    <div class="onb-top-right">
      <button class="onb-lang" id="onbLang">${t('lang_toggle')}</button>
      <a href="/login" id="onbLogin">${t('onb_already_account')} <strong>${t('onb_login')}</strong></a>
    </div>
  </div>
  <div class="onb-progress"><div class="onb-progress-fill" id="onbProgressFill" style="width:${progress()}%"></div></div>
  <div class="onb-body" id="onbBody"></div>
</div>`;
  }

  function renderStep() {
    const body = document.getElementById('onbBody');
    if (!body) return;

    body.querySelectorAll('.onb-stage:not(.active)').forEach(el => el.remove());
    const prev = body.querySelector('.onb-stage.active');

    let html = '';
    if (!state.role) html = stepRoleSelect();
    else if (state.role === 'employer') html = employerStep(state.step);
    else html = employeeStep(state.step);

    const stage = document.createElement('div');
    stage.innerHTML = `<div class="onb-content${state.step === 0 && !state.role ? ' wide' : ''}">${html}</div>`;
    body.appendChild(stage);

    if (!prev) {
      stage.className = 'onb-stage active';
    } else {
      stage.className = 'onb-stage right';
      stage.getBoundingClientRect();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          prev.className = 'onb-stage left';
          stage.className = 'onb-stage active';
          setTimeout(() => prev.remove(), 700);
        });
      });
    }

    document.getElementById('onbProgressFill').style.width = progress() + '%';
    bindStep(stage);
  }

  function goBack() {
    if (state.step > 1) { state.step--; renderStepReverse(); }
    else if (state.step === 1) { state.step = 0; state.role = null; renderStepReverse(); }
  }

  function renderStepReverse() {
    const body = document.getElementById('onbBody');
    if (!body) return;

    body.querySelectorAll('.onb-stage:not(.active)').forEach(el => el.remove());
    const prev = body.querySelector('.onb-stage.active');

    let html = '';
    if (!state.role) html = stepRoleSelect();
    else if (state.role === 'employer') html = employerStep(state.step);
    else html = employeeStep(state.step);

    const stage = document.createElement('div');
    stage.className = 'onb-stage left';
    stage.innerHTML = `<div class="onb-content${state.step === 0 && !state.role ? ' wide' : ''}">${html}</div>`;
    body.appendChild(stage);

    stage.getBoundingClientRect();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (prev) prev.className = 'onb-stage right';
        stage.className = 'onb-stage active';
        if (prev) setTimeout(() => prev.remove(), 700);
      });
    });

    document.getElementById('onbProgressFill').style.width = progress() + '%';
    bindStep(stage);
  }

  // ─── Step Templates ────────────────────────────────
  function stepRoleSelect() {
    return `
      <h1 class="onb-h">${t('onb_welcome')}</h1>
      <p class="onb-sub">${t('onb_welcome_sub')}</p>
      <div class="onb-roles">
        <div class="onb-role" data-role="employer">
          <div class="onb-role-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--aqua)" stroke-width="1.5"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg></div>
          <div class="onb-role-title">${t('onb_role_employer_title')}</div>
          <div class="onb-role-desc">${t('onb_role_employer_desc')}</div>
        </div>
        <div class="onb-role" data-role="employee">
          <div class="onb-role-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
          <div class="onb-role-title">${t('onb_role_employee_title')}</div>
          <div class="onb-role-desc">${t('onb_role_employee_desc')}</div>
        </div>
      </div>`;
  }

  function employerStep(n) {
    const back = n > 0 ? `<button class="onb-back" id="onbBack">${backArrow}</button>` : '';
    if (n === 1) return `${back}<h1 class="onb-h">${t('onb_e_step1_h')}</h1><p class="onb-sub">${t('onb_e_step1_sub')}</p><div class="onb-field"><input class="onb-input" id="onbCompany" type="text" placeholder="${t('onb_e_step1_placeholder')}" value="${state.data.company||''}" autofocus></div><button class="onb-btn" id="onbNext" disabled>${t('onb_next')}</button>`;
    if (n === 2) return `${back}<h1 class="onb-h">${t('onb_e_step2_h')}</h1><p class="onb-sub">${t('onb_e_step2_sub')}</p><div class="onb-field"><div class="onb-label">${t('onb_e_step2_name')}</div><input class="onb-input" id="onbName" type="text" placeholder="${t('onb_e_step2_name_ph')}" value="${state.data.name||''}"></div><div class="onb-field"><div class="onb-label">${t('onb_e_step2_email')}</div><input class="onb-input" id="onbEmail" type="email" placeholder="${t('onb_e_step2_email_ph')}" value="${state.data.email||''}"></div><button class="onb-btn" id="onbNext" disabled>${t('onb_next')}</button>`;
    if (n === 3) return `${back}<h1 class="onb-h">${t('onb_e_step3_h')}</h1><p class="onb-sub">${t('onb_e_step3_sub')}</p><div class="onb-field"><div class="onb-label">${t('onb_e_step3_size')}</div><div class="onb-tiles" id="onbTiles"><div class="onb-tile${state.data.size==='1-50'?' active':''}" data-val="1-50"><div class="onb-tile-val">1-50</div><div class="onb-tile-lbl">${t('onb_e_step3_employees')}</div></div><div class="onb-tile${state.data.size==='50-200'?' active':''}" data-val="50-200"><div class="onb-tile-val">50-200</div><div class="onb-tile-lbl">${t('onb_e_step3_employees')}</div></div><div class="onb-tile${state.data.size==='200-500'?' active':''}" data-val="200-500"><div class="onb-tile-val">200-500</div><div class="onb-tile-lbl">${t('onb_e_step3_employees')}</div></div><div class="onb-tile${state.data.size==='500+'?' active':''}" data-val="500+"><div class="onb-tile-val">500+</div><div class="onb-tile-lbl">${t('onb_e_step3_employees')}</div></div></div></div><div class="onb-field"><div class="onb-label">${t('onb_e_step3_payroll')}</div><select class="onb-select" id="onbPayroll"><option value="" disabled ${!state.data.payroll?'selected':''}>${t('onb_e_step3_payroll_ph')}</option><option value="Nomipaq" ${state.data.payroll==='Nomipaq'?'selected':''}>Nomipaq</option><option value="Aspel NOI" ${state.data.payroll==='Aspel NOI'?'selected':''}>Aspel NOI</option><option value="CONTPAQi" ${state.data.payroll==='CONTPAQi'?'selected':''}>CONTPAQi</option><option value="Workday" ${state.data.payroll==='Workday'?'selected':''}>Workday</option><option value="ADP" ${state.data.payroll==='ADP'?'selected':''}>ADP</option><option value="Otro" ${state.data.payroll==='Otro'?'selected':''}>${t('onb_e_step3_payroll_other')}</option></select></div><button class="onb-btn" id="onbNext" disabled>${t('onb_next')}</button>`;
    if (n === 4) return `${back}<h1 class="onb-h">${t('onb_e_step5_h')}</h1><p class="onb-sub">${t('onb_e_step5_sub')}</p><div class="onb-error" id="onbError"></div><div class="onb-field"><div class="onb-label">${t('onb_e_step5_pass')}</div><input class="onb-input" id="onbPass" type="password" placeholder="${t('onb_e_step5_pass_ph')}" minlength="6"><div class="onb-strength"><div class="onb-strength-fill" id="onbStrength"></div></div></div><div class="onb-terms"><input type="checkbox" id="onbTerms"><label for="onbTerms">${t('onb_e_step5_terms')} <a href="/terms" onclick="event.stopPropagation();event.preventDefault();window.open('/terms','_blank')">${t('onb_e_step5_terms_link')}</a></label></div><button class="onb-btn" id="onbCreate" disabled>${t('onb_e_step5_btn')}</button>`;
    if (n === 5) return `<div class="onb-celebration"><div class="onb-check-circle" style="background:rgba(162,134,87,0.12)"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div><div class="onb-approved-tag"><span class="onb-approved-dot" style="background:var(--gold)"></span>${t('onb_e_step6_badge')}</div><h1 class="onb-h">${t('onb_e_step6_h')}</h1><p class="onb-sub">${t('onb_e_step6_sub')}</p><button class="onb-btn" id="onbToHome">${t('onb_e_step6_cta')}</button></div>`;
    return '';
  }

  function employeeStep(n) {
    const back = n > 0 ? `<button class="onb-back" id="onbBack">${backArrow}</button>` : '';
    if (n === 1) return `${back}<h1 class="onb-h">${t('onb_m_step1_h')}</h1><p class="onb-sub">${t('onb_m_step1_sub')}</p><div class="onb-field"><input class="onb-input big" id="onbCode" type="text" placeholder="${t('onb_m_step1_placeholder')}" maxlength="8" value="${state.data.code||''}" autofocus><div class="onb-input-hint" id="onbCodeHint">${t('onb_m_step1_hint')}</div></div><button class="onb-btn" id="onbNext" disabled>${t('onb_next')}</button>`;
    if (n === 2) return `${back}<h1 class="onb-h">${t('onb_m_step2_h')}</h1><p class="onb-sub">${t('onb_m_step2_sub')}</p><div class="onb-field"><div class="onb-label">${t('onb_m_step2_name')}</div><input class="onb-input" id="onbName" type="text" placeholder="${t('onb_m_step2_name_ph')}" value="${state.data.name||''}"></div><div class="onb-field"><div class="onb-label">${t('onb_m_step2_email')}</div><input class="onb-input" id="onbEmail" type="email" placeholder="${t('onb_m_step2_email_ph')}" value="${state.data.email||''}"></div><button class="onb-btn" id="onbNext" disabled>${t('onb_next')}</button>`;
    if (n === 3) {
      const salary = state.data.salary || 15000;
      const credit = Math.min(Math.round(salary * 0.30 / 100) * 100, 5000);
      return `${back}<h1 class="onb-h">${t('onb_m_step3_h')}</h1><p class="onb-sub">${t('onb_m_step3_sub')}</p><div class="onb-field"><div class="onb-label">${t('onb_m_step3_salary')}</div><div style="position:relative"><span style="position:absolute;left:0;top:50%;transform:translateY(-50%);font-size:18px;font-weight:600;color:var(--brand);opacity:.3">$</span><input class="onb-input" id="onbSalary" type="text" inputmode="numeric" placeholder="${t('onb_m_step3_salary_ph')}" value="${fmt(salary)}" style="padding-left:20px"><span style="position:absolute;right:0;top:50%;transform:translateY(-50%);font-size:12px;font-weight:600;color:var(--t3)">MXN</span></div></div><div class="onb-credit-sim"><div class="onb-ring-wrap"><svg viewBox="0 0 200 200"><circle class="onb-ring-bg" cx="100" cy="100" r="90"/><circle class="onb-ring-fill" id="onbRing" cx="100" cy="100" r="90"/></svg><div class="onb-ring-text"><div class="onb-ring-amount" id="onbCreditAmt"><span class="onb-cur">$</span>${fmt(credit)}</div><div class="onb-ring-label">${t('onb_m_step3_credit_label')}</div></div></div></div><button class="onb-btn" id="onbNext">${t('onb_next')}</button>`;
    }
    if (n === 4) return `${back}<h1 class="onb-h">${t('onb_m_step4_h')}</h1><p class="onb-sub">${t('onb_m_step4_sub')}</p><div class="onb-error" id="onbError"></div><div class="onb-field"><div class="onb-label">${t('onb_m_step4_pass')}</div><input class="onb-input" id="onbPass" type="password" placeholder="${t('onb_m_step4_pass_ph')}" minlength="6"><div class="onb-strength"><div class="onb-strength-fill" id="onbStrength"></div></div></div><div class="onb-terms"><input type="checkbox" id="onbTerms"><label for="onbTerms">${t('onb_m_step4_terms')} <a href="/terms" onclick="event.stopPropagation();event.preventDefault();window.open('/terms','_blank')">${t('onb_m_step4_terms_link')}</a></label></div><button class="onb-btn" id="onbCreate" disabled>${t('onb_m_step4_btn')}</button>`;
    if (n === 5) {
      const credit = state.data.credit || 5000;
      return `<div class="onb-celebration"><div class="onb-check-circle"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div><div class="onb-approved-tag"><span class="onb-approved-dot"></span>${t('onb_m_step5_tag')}</div><h1 class="onb-h">${t('onb_m_step5_h')}</h1><div class="onb-big-amount" id="onbBigAmt"><span class="onb-cur">$</span>0</div><p style="font-size:13px;color:var(--t3);margin-bottom:32px">MXN</p><p class="onb-sub">${t('onb_m_step5_sub')}</p><button class="onb-btn" id="onbToDash">${t('onb_m_step5_cta')}</button></div>`;
    }
    return '';
  }

  // ─── Bind interactions per step ─────────────────────
  let codeTimer = null;

  function bindStep(stg) {
    const $ = (sel) => stg.querySelector(sel);
    const $$ = (sel) => stg.querySelectorAll(sel);

    document.getElementById('onbLang')?.addEventListener('click', () => toggleLang());
    document.getElementById('onbLogin')?.addEventListener('click', (e) => { e.preventDefault(); navigate('/login'); });
    $('[id="onbBack"]')?.addEventListener('click', goBack);

    // Role selection
    $$('.onb-role').forEach(card => {
      card.addEventListener('click', () => {
        state.role = card.dataset.role;
        card.classList.add('selected');
        setTimeout(() => { state.step = 1; renderStep(); }, 350);
      });
    });

    if (state.step === 0 && state.role) {
      setTimeout(() => { state.step = 1; renderStep(); }, 100);
    }

    // EMPLOYER Step 1
    const companyIn = $('[id="onbCompany"]');
    if (companyIn) {
      companyIn.focus();
      const btn = $('[id="onbNext"]');
      companyIn.addEventListener('input', () => { btn.disabled = companyIn.value.trim().length < 2; });
      if (companyIn.value.trim().length >= 2) btn.disabled = false;
      btn.addEventListener('click', () => { state.data.company = companyIn.value.trim(); state.step = 2; renderStep(); });
      companyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    }

    // EMPLOYER Step 2
    const nameIn = $('[id="onbName"]');
    const emailIn = $('[id="onbEmail"]');
    if (nameIn && emailIn && state.role === 'employer' && state.step === 2) {
      nameIn.focus();
      const btn = $('[id="onbNext"]');
      function checkStep2() { btn.disabled = !(nameIn.value.trim().length >= 2 && emailIn.value.includes('@')); }
      nameIn.addEventListener('input', checkStep2);
      emailIn.addEventListener('input', checkStep2);
      checkStep2();
      btn.addEventListener('click', () => { state.data.name = nameIn.value.trim(); state.data.email = emailIn.value.trim(); state.step = 3; renderStep(); });
      emailIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    }

    // EMPLOYER Step 3
    const tiles = $('[id="onbTiles"]');
    const payroll = $('[id="onbPayroll"]');
    if (tiles && payroll) {
      const btn = $('[id="onbNext"]');
      function checkStep3() { btn.disabled = !(state.data.size && state.data.payroll); }
      tiles.querySelectorAll('.onb-tile').forEach(tile => {
        tile.addEventListener('click', () => {
          tiles.querySelectorAll('.onb-tile').forEach(x => x.classList.remove('active'));
          tile.classList.add('active');
          state.data.size = tile.dataset.val;
          checkStep3();
        });
      });
      payroll.addEventListener('change', () => { state.data.payroll = payroll.value; checkStep3(); });
      checkStep3();
      btn.addEventListener('click', () => { state.step = 4; renderStep(); });
    }

    // Step 4/5 - password (employer & employee share this binding)
    const passIn = $('[id="onbPass"]');
    const termsBox = $('[id="onbTerms"]');
    const createBtn = $('[id="onbCreate"]');
    if (passIn && termsBox && createBtn) {
      const strengthBar = $('[id="onbStrength"]');
      function checkCreate() { createBtn.disabled = !(passIn.value.length >= 6 && termsBox.checked); }
      passIn.addEventListener('input', () => {
        const s = passwordStrength(passIn.value);
        strengthBar.className = 'onb-strength-fill ' + s;
        checkCreate();
      });
      termsBox.addEventListener('change', checkCreate);
      createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        createBtn.innerHTML = '<span class="spinner"></span>' + (state.role === 'employer' ? t('onb_e_step5_creating') : t('onb_m_step4_creating'));
        const errEl = $('[id="onbError"]');
        errEl.classList.remove('show');
        try {
          const cred = await auth.createUserWithEmailAndPassword(state.data.email, passIn.value);
          const uid = cred.user.uid;
          if (state.role === 'employer') {
            const employerCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            state.data.employerCode = employerCode;
            await db.collection('employers').doc(uid).set({
              name: state.data.name, companyName: state.data.company, email: state.data.email,
              employerCode, companySize: state.data.size, payrollSystem: state.data.payroll,
              status: 'pending_verification',
              docRFC: null,
              docId: null,
              docAddress: null,
              submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              totalEmployees: 0, activeLoans: 0, totalDisbursed: 0
            });
          } else {
            const credit = state.data.credit || 5000;
            await db.collection('employees').doc(uid).set({
              name: state.data.name, email: state.data.email,
              employerId: state.employerDoc.id, employerName: state.employerDoc.data().companyName,
              monthlySalary: state.data.salary || 15000, creditLimit: credit, availableCredit: credit,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('employers').doc(state.employerDoc.id).update({ totalEmployees: firebase.firestore.FieldValue.increment(1) });
          }
          state.step = 5;
          renderStep();
          setTimeout(fireConfetti, 300);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.classList.add('show');
          createBtn.disabled = false;
          createBtn.textContent = state.role === 'employer' ? t('onb_e_step5_btn') : t('onb_m_step4_btn');
        }
      });
    }

    // EMPLOYER Step 6 - verification pending
    $('[id="onbToHome"]')?.addEventListener('click', () => { navigate('/'); });

    // EMPLOYEE Step 5 - go to dashboard
    $('[id="onbToDash"]')?.addEventListener('click', () => {
      navigate(state.role === 'employer' ? '/employer/dashboard' : '/employee/dashboard');
    });

    // EMPLOYEE Step 1
    const codeIn = $('[id="onbCode"]');
    if (codeIn) {
      codeIn.focus();
      const btn = $('[id="onbNext"]');
      const hint = $('[id="onbCodeHint"]');
      codeIn.addEventListener('input', () => {
        codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const code = codeIn.value.trim();
        if (code.length < 4) {
          codeIn.classList.remove('valid', 'invalid');
          hint.className = 'onb-input-hint';
          hint.textContent = t('onb_m_step1_hint');
          btn.disabled = true;
          state.employerDoc = null;
          return;
        }
        clearTimeout(codeTimer);
        hint.className = 'onb-input-hint';
        hint.textContent = t('onb_m_step1_searching');
        codeTimer = setTimeout(async () => {
          try {
            const snap = await db.collection('employers').where('employerCode', '==', code).limit(1).get();
            if (!snap.empty) {
              state.employerDoc = snap.docs[0];
              state.data.code = code;
              codeIn.classList.remove('invalid');
              codeIn.classList.add('valid');
              hint.className = 'onb-input-hint success';
              hint.textContent = t('onb_m_step1_found') + ': ' + snap.docs[0].data().companyName;
              btn.disabled = false;
            } else {
              state.employerDoc = null;
              codeIn.classList.remove('valid');
              codeIn.classList.add('invalid');
              hint.className = 'onb-input-hint error';
              hint.textContent = t('onb_m_step1_not_found');
              btn.disabled = true;
            }
          } catch (e) {
            hint.textContent = t('onb_m_step1_hint');
            btn.disabled = true;
          }
        }, 500);
      });
      if (state.data.code && state.employerDoc) {
        btn.disabled = false;
        codeIn.classList.add('valid');
        hint.className = 'onb-input-hint success';
        hint.textContent = t('onb_m_step1_found') + ': ' + state.employerDoc.data().companyName;
      }
      btn.addEventListener('click', () => { state.step = 2; renderStep(); });
      codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    }

    // EMPLOYEE Step 2
    if (nameIn && emailIn && state.role === 'employee' && state.step === 2) {
      nameIn.focus();
      const btn = $('[id="onbNext"]');
      function checkM2() { btn.disabled = !(nameIn.value.trim().length >= 2 && emailIn.value.includes('@')); }
      nameIn.addEventListener('input', checkM2);
      emailIn.addEventListener('input', checkM2);
      checkM2();
      btn.addEventListener('click', () => { state.data.name = nameIn.value.trim(); state.data.email = emailIn.value.trim(); state.step = 3; renderStep(); });
      emailIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    }

    // EMPLOYEE Step 3
    const salaryIn = $('[id="onbSalary"]');
    const ring = $('[id="onbRing"]');
    if (salaryIn && ring) {
      function updateCredit() {
        const sal = parseMoney(salaryIn.value);
        state.data.salary = sal || 15000;
        const credit = Math.min(Math.round((state.data.salary) * 0.30 / 100) * 100, 5000);
        state.data.credit = Math.max(credit, 500);
        const pct = state.data.credit / 5000;
        const circumference = 2 * Math.PI * 90;
        ring.style.strokeDashoffset = circumference * (1 - pct);
        $('[id="onbCreditAmt"]').innerHTML = '<span class="onb-cur">$</span>' + fmt(state.data.credit);
      }
      salaryIn.addEventListener('input', (e) => {
        let raw = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = raw ? fmt(parseInt(raw)) : '';
        updateCredit();
      });
      setTimeout(updateCredit, 100);
      const btn = $('[id="onbNext"]');
      btn.addEventListener('click', () => { state.step = 4; renderStep(); });
    }

    // EMPLOYEE Step 5
    const bigAmt = $('[id="onbBigAmt"]');
    if (bigAmt && state.step === 5 && state.role === 'employee') {
      setTimeout(() => countUp(bigAmt, state.data.credit || 5000, 1500), 400);
    }

    document.onkeydown = (e) => {
      if (e.key === 'Escape' && state.step > 0 && state.step < 5) goBack();
    };
  }

  // ─── Init onboarding ───────────────────────────────
  app.innerHTML = shell();
  renderStep();
}

// ─── HOME PAGE ───────────────────────────────────────────
function renderHome(app) { app.innerHTML = getHomeHTML(); initHomeJS(); }

function getHomeHTML() {
  return `
<nav class="nav"><div class="nav-inner"><div class="nav-left"><div class="hamburger" id="burger"><span></span><span></span><span></span></div><a href="/" class="nav-logo" onclick="event.preventDefault();navigate('/')">${vidaLogo()}</a><div class="nav-links"><a href="#employers">${t('nav_employers')}</a><a href="#employees">${t('nav_employees')}</a><a href="#trust">${t('nav_trust')}</a><a href="#how">${t('nav_how')}</a></div></div><div class="nav-right"><a href="#" class="nav-lang" onclick="event.preventDefault();toggleLang()">${t('lang_toggle')}</a><a href="/login" class="nav-login" onclick="event.preventDefault();navigate('/login')">${t('nav_login')}</a><a href="/onboarding" class="nav-cta" onclick="event.preventDefault();navigate('/onboarding')">${t('nav_get_started')}</a></div></div></nav>
<div class="nav-menu" id="navMenu"><div class="menu-close" id="menuClose">✕</div><a href="#employers" class="menu-link">${t('nav_employers')}</a><a href="#employees" class="menu-link">${t('nav_employees')}</a><a href="#trust" class="menu-link">${t('nav_trust')}</a><a href="#how" class="menu-link">${t('nav_how')}</a><a href="/login" onclick="event.preventDefault();navigate('/login')" class="menu-link">${t('nav_login')}</a><a href="/onboarding" onclick="event.preventDefault();navigate('/onboarding')" class="menu-link">${t('nav_get_started')}</a><a href="#" onclick="event.preventDefault();toggleLang()" class="menu-link">${t('lang_toggle')}</a></div>

<section class="hero"><div class="hero-blob b1"></div><div class="hero-blob b2"></div><div class="hero-blob b3"></div><div class="hero-inner"><div class="hero-text"><div class="hero-badge"><span class="badge-dot"></span><span class="badge-text">${t('hero_badge')}</span></div><h1>${t('hero_h1')}</h1><p class="hero-sub">${t('hero_sub')}</p><div class="hero-actions"><a href="/employers" class="hero-cta" onclick="event.preventDefault();navigate('/employers')">${t('hero_cta_employer')}</a><a href="/employees" class="hero-cta-2" onclick="event.preventDefault();navigate('/employees')">${t('hero_cta_employee')}</a></div></div><div class="hero-widget"><div class="phone-ring"></div><div class="phone-ring-2"></div><div class="phone-glow"></div><div class="chip chip-1"><div class="chip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div><div class="chip-text"><div class="chip-val">${t('chip_24hrs')}</div><div class="chip-lbl">${t('chip_disbursement')}</div></div></div><div class="chip chip-2"><div class="chip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg></div><div class="chip-text"><div class="chip-val">${t('chip_0fees')}</div><div class="chip-lbl">${t('chip_transparent')}</div></div></div><div class="chip chip-3"><div class="chip-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div><div class="chip-text"><div class="chip-val">${t('chip_encrypted')}</div><div class="chip-lbl">${t('chip_bankgrade')}</div></div></div><div class="phone-mock"><div class="pm-head"><span class="pm-label">${t('phone_available')}</span><div class="pm-active"><span class="pm-dot"></span>${t('phone_active')}</div></div><div class="pm-amount"><div class="pm-big"><span class="cur">$</span>5,000</div></div><div class="pm-unit">${t('phone_currency')}</div><div class="pm-div"></div><div class="pm-rows"><div class="pm-row"><span class="pm-row-label">${t('phone_repayment')}</span><span class="pm-row-val">${t('phone_repayment_val')}</span></div><div class="pm-row"><span class="pm-row-label">${t('phone_disbursement')}</span><span class="pm-row-val">${t('phone_disbursement_val')}</span></div><div class="pm-row"><span class="pm-row-label">${t('phone_deduction')}</span><span class="pm-row-val">${t('phone_deduction_val')}</span></div></div><div class="pm-progress"><div class="pm-prog-top"><span>${t('phone_utilization')}</span><span>60%</span></div><div class="pm-prog-bar"><div class="pm-prog-fill"></div></div></div><button class="pm-btn" onclick="navigate('/onboarding',{role:'employee'})">${t('phone_request')} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button></div></div></div></section>

<div class="benefits"><div class="benefits-inner"><div class="ben"><svg class="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5" opacity=".45"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg><div class="ben-val">$0</div><div class="ben-lbl">${t('ben_fees')}</div></div><div class="ben-sep"></div><div class="ben"><svg class="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><div class="ben-val">24hrs</div><div class="ben-lbl">${t('ben_disbursement')}</div></div><div class="ben-sep"></div><div class="ben"><svg class="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5" opacity=".45"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg><div class="ben-val">100%</div><div class="ben-lbl">${t('ben_encrypted')}</div></div><div class="ben-sep"></div><div class="ben"><svg class="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".35"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12h8M12 8v8" stroke-linecap="round"/></svg><div class="ben-val">Swiss</div><div class="ben-lbl">${t('ben_governance')}</div></div></div></div>

<section class="statement-section"><div class="statement-inner"><div class="statement-text rv"><h2>${t('stmt_h2')}</h2><p>${t('stmt_p')}</p></div><div class="emo-col"><div class="emo-row rv d1"><div class="emo-icon c1"><svg viewBox="0 0 24 24" fill="none" stroke="#dc503c" stroke-width="1.5" opacity=".6"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></svg></div><div class="emo-info"><div class="emo-title">${t('emo_1_title')}</div><div class="emo-desc">${t('emo_1_desc')}</div></div></div><div class="emo-row rv d2"><div class="emo-icon c2"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5" opacity=".6"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="emo-info"><div class="emo-title">${t('emo_2_title')}</div><div class="emo-desc">${t('emo_2_desc')}</div></div></div><div class="emo-row rv d3"><div class="emo-icon c3"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div><div class="emo-info"><div class="emo-title">${t('emo_3_title')}</div><div class="emo-desc">${t('emo_3_desc')}</div></div></div><div class="emo-row rv d4"><div class="emo-icon c4"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".6"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg></div><div class="emo-info"><div class="emo-title">${t('emo_4_title')}</div><div class="emo-desc">${t('emo_4_desc')}</div></div></div></div></div></section>

<section class="section" id="how"><div class="wrap"><div class="hiw-grid"><div class="hiw-text"><div class="tag rv">${t('hiw_tag')}</div><h2 class="sh rv d1">${t('hiw_h2')}</h2><p class="sp rv d2">${t('hiw_p')}</p></div><div class="steps"><div class="step rv d2"><div class="step-n">1</div><div><div class="step-title">${t('step_1_title')}</div><div class="step-desc">${t('step_1_desc')}</div></div></div><div class="step rv d3"><div class="step-n">2</div><div><div class="step-title">${t('step_2_title')}</div><div class="step-desc">${t('step_2_desc')}</div></div></div><div class="step rv d4"><div class="step-n">3</div><div><div class="step-title">${t('step_3_title')}</div><div class="step-desc">${t('step_3_desc')}</div></div></div><div class="step rv d5"><div class="step-n">4</div><div><div class="step-title">${t('step_4_title')}</div><div class="step-desc">${t('step_4_desc')}</div></div></div></div></div></div></section>

<section class="calc"><div class="calc-glow"></div><div class="wrap"><div class="calc-grid"><div class="calc-text"><div class="tag rv">${t('calc_tag')}</div><h2 class="sh rv d1">${t('calc_h2')}</h2><p class="sp rv d2">${t('calc_p')}</p></div><div class="calc-form rv d3"><div class="cf"><div class="cf-label">${t('calc_salary')}</div><div class="sal-wrap"><span class="sal-pre">$</span><input class="sal-in" type="text" inputmode="numeric" id="salaryInput" value="15,000" placeholder="${t('calc_salary_placeholder')}"><span class="sal-suf">MXN</span></div></div><div class="cf"><div class="cf-row"><span class="cf-label">${t('calc_credit')}</span><span class="cf-val" id="creditDisplay">$3,000</span></div><div class="slider-wrap"><div class="sw"><div class="sw-fill" id="sliderFill" style="width:55.6%"></div></div><input type="range" min="500" max="5000" step="100" value="3000" id="creditSlider"><div class="sw-labels"><span>$500</span><span>$5,000</span></div></div></div><div class="cf"><div class="cf-row"><span class="cf-label">${t('calc_term')}</span><span class="cf-val">30 ${t('calc_days')} · ${t('calc_rate')}</span></div></div><div class="calc-line"></div><div class="calc-result"><div class="calc-result-label">${t('calc_result_label')}</div><div class="calc-result-num" id="paymentDisplay"><span class="cr">$</span>3,900<span class="dc">.00</span></div></div><div class="calc-note">${t('calc_note')}</div><a href="/onboarding" class="calc-cta" onclick="event.preventDefault();navigate('/onboarding',{role:'employee'})">${t('calc_cta')}</a></div></div></div></section>

<section class="section" id="employers"><div class="wrap"><div class="emp-grid"><div class="emp-text"><div class="tag rv">${t('emp_tag')}</div><h2 class="sh rv d1">${t('emp_h2')}</h2><p class="sp rv d2">${t('emp_p')}</p><a href="/employers" class="section-link rv d3" onclick="event.preventDefault();navigate('/employers')">${t('emp_link')} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a></div><div><div class="chart rv d3" id="chart"><div class="bar" style="height:28%"></div><div class="bar" style="height:36%"></div><div class="bar" style="height:48%"></div><div class="bar" style="height:42%"></div><div class="bar" style="height:56%"></div><div class="bar" style="height:50%"></div><div class="bar" style="height:66%"></div><div class="bar hi" style="height:85%"></div></div><div class="metrics rv d4"><div class="metric"><div class="metric-v">94.2%</div><div class="metric-l">${t('emp_retention')}</div><div class="metric-c"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 19V5M5 12l7-7 7 7"/></svg>+3.1%</div></div><div class="metric"><div class="metric-v">$0</div><div class="metric-l">${t('emp_liability')}</div><div class="metric-c">${t('emp_liability_c')}</div></div><div class="metric"><div class="metric-v">2 ${t('calc_days')}</div><div class="metric-l">${t('emp_integration')}</div><div class="metric-c">${t('emp_integration_c')}</div></div><div class="metric"><div class="metric-v">87%</div><div class="metric-l">${t('emp_adoption')}</div><div class="metric-c"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 19V5M5 12l7-7 7 7"/></svg>+8.6%</div></div></div></div></div></div></section>

<section class="section tinted" id="employees"><div class="wrap"><div class="scenario-header"><div class="tag rv">${t('scn_tag')}</div><h2 class="sh rv d1">${t('scn_h2')}</h2><p class="sp rv d2">${t('scn_p')}</p></div><div class="scenario-grid rv d3"><div class="scenario"><div class="scenario-icon r"><svg viewBox="0 0 24 24" fill="none" stroke="#dc503c" stroke-width="1.5" opacity=".6"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="scenario-t">${t('scn_1_title')}</div><div class="scenario-d">${t('scn_1_desc')}</div><div class="scenario-amt">$3,500</div></div><div class="scenario"><div class="scenario-icon a"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".6"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div><div class="scenario-t">${t('scn_2_title')}</div><div class="scenario-d">${t('scn_2_desc')}</div><div class="scenario-amt">$4,200</div></div><div class="scenario"><div class="scenario-icon b"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div><div class="scenario-t">${t('scn_3_title')}</div><div class="scenario-d">${t('scn_3_desc')}</div><div class="scenario-amt">$2,800</div></div><div class="scenario"><div class="scenario-icon g"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5" opacity=".6"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div><div class="scenario-t">${t('scn_4_title')}</div><div class="scenario-d">${t('scn_4_desc')}</div><div class="scenario-amt">$5,000</div></div></div></div></section>

<section class="section" id="trust"><div class="wrap"><div class="tag rv">${t('trust_tag')}</div><h2 class="sh rv d1">${t('trust_h2')}</h2><p class="sp rv d2" style="margin-bottom:56px">${t('trust_p')}</p><div class="trust-grid rv d3"><div class="trust-item"><div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".4"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12h8M12 8v8" stroke-linecap="round"/></svg></div><div><div class="trust-t">${t('trust_1_title')}</div><div class="trust-d">${t('trust_1_desc')}</div></div></div><div class="trust-item"><div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".4"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg></div><div><div class="trust-t">${t('trust_2_title')}</div><div class="trust-d">${t('trust_2_desc')}</div></div></div><div class="trust-item"><div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".4"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div><div><div class="trust-t">${t('trust_3_title')}</div><div class="trust-d">${t('trust_3_desc')}</div></div></div><div class="trust-item"><div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".4"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg></div><div><div class="trust-t">${t('trust_4_title')}</div><div class="trust-d">${t('trust_4_desc')}</div></div></div></div><div class="trust-link rv d4"><a href="/security" onclick="event.preventDefault();navigate('/security')">${t('trust_link')} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a></div></div></section>

<section class="closing"><div class="closing-glow"></div><h2 class="rv">${t('close_h2')}</h2><p class="closing-sub rv d1">${t('close_sub')}</p><a href="/onboarding" class="closing-btn rv d2" onclick="event.preventDefault();navigate('/onboarding')">${t('close_cta')}</a></section>

<footer class="footer"><div class="footer-inner"><div class="ft-top"><div class="ft-brand"><div class="ft-logo">${vidaLogo('ft')}</div><p class="ft-tag">${t('ft_tagline')}</p></div><div class="ft-col"><div class="ft-h">${t('ft_platform')}</div><a href="/employers" onclick="event.preventDefault();navigate('/employers')">${t('nav_employers')}</a><a href="/employees" onclick="event.preventDefault();navigate('/employees')">${t('nav_employees')}</a><a href="/partners" onclick="event.preventDefault();navigate('/partners')">${t('nav_partners')}</a><a href="/investors" onclick="event.preventDefault();navigate('/investors')">${t('nav_investors')}</a></div><div class="ft-col"><div class="ft-h">${t('ft_company')}</div><a href="/about" onclick="event.preventDefault();navigate('/about')">${t('ft_about')}</a><a href="/security" onclick="event.preventDefault();navigate('/security')">${t('ft_security')}</a><a href="/privacy" onclick="event.preventDefault();navigate('/privacy')">${t('ft_privacy')}</a><a href="/terms" onclick="event.preventDefault();navigate('/terms')">${t('ft_terms')}</a></div><div class="ft-col"><div class="ft-h">${t('ft_connect')}</div><a href="/contact" onclick="event.preventDefault();navigate('/contact')">${t('nav_contact')}</a><a href="https://linkedin.com" target="_blank" rel="noopener">LinkedIn</a><a href="/press" onclick="event.preventDefault();navigate('/press')">${t('ft_press')}</a></div></div><div class="ft-btm"><span>&copy; 2025 VIDA</span><div class="ft-btm-links"><a href="#" onclick="event.preventDefault();toggleLang()">${t('lang_toggle')}</a><a href="/privacy" onclick="event.preventDefault();navigate('/privacy')">${t('ft_privacy_policy')}</a><a href="/terms" onclick="event.preventDefault();navigate('/terms')">${t('ft_terms_service')}</a><span style="color:rgba(255,255,255,.3)">·</span><a href="https://www.condusef.gob.mx" target="_blank" rel="noopener">CONDUSEF</a><span style="color:rgba(255,255,255,.3)">·</span><a href="tel:018009998080">01 800 999 8080</a></div></div></div></footer>`;
}

function initHomeJS() {
  const burger = document.getElementById('burger'), navMenu = document.getElementById('navMenu'), menuClose = document.getElementById('menuClose');
  if (burger && navMenu) { burger.addEventListener('click', () => { burger.classList.toggle('open'); navMenu.classList.toggle('open'); }); menuClose?.addEventListener('click', () => { burger.classList.remove('open'); navMenu.classList.remove('open'); }); navMenu.querySelectorAll('.menu-link').forEach(a => a.addEventListener('click', () => { burger.classList.remove('open'); navMenu.classList.remove('open'); })); }
  const obs = new IntersectionObserver(e => { e.forEach(x => { if (x.isIntersecting) x.target.classList.add('vis'); }); }, { threshold: .1, rootMargin: '0px 0px -60px 0px' });
  document.querySelectorAll('.rv').forEach(el => obs.observe(el));
  const cObs = new IntersectionObserver(e => { e.forEach(x => { if (x.isIntersecting) { x.target.querySelectorAll('.bar').forEach((b, i) => { const h = b.style.height; b.style.height = '0%'; setTimeout(() => { b.style.height = h; }, i * 80); }); } }); }, { threshold: .3 });
  document.querySelectorAll('.chart').forEach(el => cObs.observe(el));
  const cs = document.getElementById('creditSlider'), sf = document.getElementById('sliderFill'), cd = document.getElementById('creditDisplay'), pd = document.getElementById('paymentDisplay'), si = document.getElementById('salaryInput');
  if (!cs) return;
  const RATE = 0.30;
  function upd() { const v = parseInt(cs.value); sf.style.width = ((v - 500) / 4500 * 100) + '%'; cd.textContent = '$' + fmt(v); const tot = v * (1 + RATE); const w = Math.floor(tot); const c = ((tot - w) * 100).toFixed(0).padStart(2, '0'); pd.innerHTML = '<span class="cr">$</span>' + fmt(w) + '<span class="dc">.' + c + '</span>'; }
  cs.addEventListener('input', upd);
  si.addEventListener('input', e => { let r = e.target.value.replace(/[^0-9]/g, ''); e.target.value = r ? fmt(parseInt(r)) : ''; });
  upd();
}

// ─── EMPLOYER LANDING PAGE ───────────────────────────────
function renderEmployerLanding(app) {
  const arrow = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
  app.innerHTML = `
<nav class="nav"><div class="nav-inner"><div class="nav-left"><div class="hamburger" id="burger"><span></span><span></span><span></span></div><a href="/" class="nav-logo" onclick="event.preventDefault();navigate('/')">${vidaLogo()}</a><div class="nav-links"><a href="/employers" onclick="event.preventDefault()">${t('nav_employers')}</a><a href="/employees" onclick="event.preventDefault();navigate('/employees')">${t('nav_employees')}</a><a href="/#trust">${t('nav_trust')}</a><a href="/#how">${t('nav_how')}</a></div></div><div class="nav-right"><a href="#" class="nav-lang" onclick="event.preventDefault();toggleLang()">${t('lang_toggle')}</a><a href="/login" class="nav-login" onclick="event.preventDefault();navigate('/login')">${t('nav_login')}</a><a href="/onboarding" class="nav-cta" onclick="event.preventDefault();navigate('/onboarding',{role:'employer'})">${t('lp_e_cta')}</a></div></div></nav>

<section class="hero" style="padding:100px 0 80px">
  <div class="hero-blob b1"></div><div class="hero-blob b2"></div>
  <div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto">
    <div class="hero-text" style="text-align:center">
      <div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('lp_e_badge')}</span></div>
      <h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('lp_e_h1')}</h1>
      <p class="hero-sub" style="max-width:520px;margin:0 auto 44px;opacity:0;animation:fu .9s ease .45s forwards">${t('lp_e_sub')}</p>
      <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;opacity:0;animation:fu .9s ease .55s forwards">
        <a href="/onboarding" class="hero-cta" onclick="event.preventDefault();navigate('/onboarding',{role:'employer'})">${t('lp_e_cta')} ${arrow}</a>
        <a href="/login" class="hero-cta-2" onclick="event.preventDefault();navigate('/login')">${t('lp_e_login')}</a>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="tag rv">${t('lp_e_why_tag')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid">
      <div class="rv d1" style="position:sticky;top:120px">
        <h2 class="sh">${t('lp_e_why_h')}</h2>
        <p class="sp">${t('lp_e_why_p')}</p>
      </div>
      <div class="rv d2">
        <div class="metrics" style="margin:0">
          <div class="metric"><div class="metric-v">${t('lp_e_why_1_v')}</div><div class="metric-l">${t('lp_e_why_1_l')}</div></div>
          <div class="metric"><div class="metric-v">${t('lp_e_why_2_v')}</div><div class="metric-l">${t('lp_e_why_2_l')}</div></div>
          <div class="metric"><div class="metric-v">${t('lp_e_why_3_v')}</div><div class="metric-l">${t('lp_e_why_3_l')}</div></div>
          <div class="metric"><div class="metric-v">${t('lp_e_why_4_v')}</div><div class="metric-l">${t('lp_e_why_4_l')}</div></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section tinted">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid">
      <div class="rv" style="position:sticky;top:120px">
        <div class="tag">${t('lp_e_how_tag')}</div>
        <h2 class="sh">${t('lp_e_how_h')}</h2>
      </div>
      <div class="steps">
        <div class="step rv d1"><div class="step-n">1</div><div><div class="step-title">${t('lp_e_how_1_t')}</div><div class="step-desc">${t('lp_e_how_1_d')}</div></div></div>
        <div class="step rv d2"><div class="step-n">2</div><div><div class="step-title">${t('lp_e_how_2_t')}</div><div class="step-desc">${t('lp_e_how_2_d')}</div></div></div>
        <div class="step rv d3"><div class="step-n">3</div><div><div class="step-title">${t('lp_e_how_3_t')}</div><div class="step-desc">${t('lp_e_how_3_d')}</div></div></div>
        <div class="step rv d4"><div class="step-n">4</div><div><div class="step-title">${t('lp_e_how_4_t')}</div><div class="step-desc">${t('lp_e_how_4_d')}</div></div></div>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="tag rv">${t('lp_e_ben_tag')}</div>
    <h2 class="sh rv d1" style="max-width:480px">${t('lp_e_ben_h')}</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:56px;border-top:1px solid rgba(25,68,69,0.04)" class="lp-grid">
      <div class="rv d2" style="padding:40px 40px 40px 0;border-bottom:1px solid rgba(25,68,69,0.04);border-right:1px solid rgba(25,68,69,0.04)">
        <div class="emo-icon c3" style="margin-bottom:16px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg></div>
        <div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('lp_e_ben_1_t')}</div>
        <div style="font-size:14px;color:var(--t3);line-height:1.6">${t('lp_e_ben_1_d')}</div>
      </div>
      <div class="rv d3" style="padding:40px 0 40px 40px;border-bottom:1px solid rgba(25,68,69,0.04)">
        <div class="emo-icon c2" style="margin-bottom:16px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5" opacity=".6"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div>
        <div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('lp_e_ben_2_t')}</div>
        <div style="font-size:14px;color:var(--t3);line-height:1.6">${t('lp_e_ben_2_d')}</div>
      </div>
      <div class="rv d4" style="padding:40px 40px 40px 0;border-right:1px solid rgba(25,68,69,0.04)">
        <div class="emo-icon c4" style="margin-bottom:16px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".6"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg></div>
        <div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('lp_e_ben_3_t')}</div>
        <div style="font-size:14px;color:var(--t3);line-height:1.6">${t('lp_e_ben_3_d')}</div>
      </div>
      <div class="rv d5" style="padding:40px 0 40px 40px">
        <div class="emo-icon c1" style="margin-bottom:16px;background:rgba(25,68,69,0.04)"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".4"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12h8M12 8v8" stroke-linecap="round"/></svg></div>
        <div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('lp_e_ben_4_t')}</div>
        <div style="font-size:14px;color:var(--t3);line-height:1.6">${t('lp_e_ben_4_d')}</div>
      </div>
    </div>
  </div>
</section>

<section class="closing"><div class="closing-glow"></div><h2 class="rv">${t('lp_e_close_h')}</h2><p class="closing-sub rv d1">${t('lp_e_close_sub')}</p><a href="/onboarding" class="closing-btn rv d2" onclick="event.preventDefault();navigate('/onboarding',{role:'employer'})">${t('lp_e_cta')}</a></section>
${pageFooter()}`;

  initLandingJS();
}

// ─── EMPLOYEE LANDING PAGE ──────────────────────────────
function renderEmployeeLanding(app) {
  const arrow = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
  app.innerHTML = `
<nav class="nav"><div class="nav-inner"><div class="nav-left"><div class="hamburger" id="burger"><span></span><span></span><span></span></div><a href="/" class="nav-logo" onclick="event.preventDefault();navigate('/')">${vidaLogo()}</a><div class="nav-links"><a href="/employers" onclick="event.preventDefault();navigate('/employers')">${t('nav_employers')}</a><a href="/employees" onclick="event.preventDefault()">${t('nav_employees')}</a><a href="/#trust">${t('nav_trust')}</a><a href="/#how">${t('nav_how')}</a></div></div><div class="nav-right"><a href="#" class="nav-lang" onclick="event.preventDefault();toggleLang()">${t('lang_toggle')}</a><a href="/login" class="nav-login" onclick="event.preventDefault();navigate('/login')">${t('nav_login')}</a><a href="/onboarding" class="nav-cta" onclick="event.preventDefault();navigate('/onboarding',{role:'employee'})">${t('lp_m_cta')}</a></div></div></nav>

<section class="hero" style="padding:100px 0 80px">
  <div class="hero-blob b1"></div><div class="hero-blob b2"></div>
  <div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto">
    <div class="hero-text" style="text-align:center">
      <div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('lp_m_badge')}</span></div>
      <h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('lp_m_h1')}</h1>
      <p class="hero-sub" style="max-width:520px;margin:0 auto 44px;opacity:0;animation:fu .9s ease .45s forwards">${t('lp_m_sub')}</p>
      <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;opacity:0;animation:fu .9s ease .55s forwards">
        <a href="/onboarding" class="hero-cta" onclick="event.preventDefault();navigate('/onboarding',{role:'employee'})">${t('lp_m_cta')} ${arrow}</a>
      </div>
      <p style="font-size:13px;color:var(--t3);margin-top:20px;opacity:0;animation:fu .9s ease .65s forwards">${t('lp_m_no_code')} <a href="#ask" style="color:var(--brand);font-weight:600;border-bottom:1px solid rgba(25,68,69,0.12);padding-bottom:1px">${t('lp_m_no_code_link')}</a></p>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="tag rv">${t('lp_m_what_tag')}</div>
    <h2 class="sh rv d1">${t('lp_m_what_h')}</h2>
    <div class="metrics rv d2" style="margin-top:48px">
      <div class="metric"><div class="metric-v">${t('lp_m_what_1_v')}</div><div class="metric-l">${t('lp_m_what_1_l')}</div><div class="metric-c">MXN</div></div>
      <div class="metric"><div class="metric-v">${t('lp_m_what_2_v')}</div><div class="metric-l">${t('lp_m_what_2_l')}</div></div>
      <div class="metric"><div class="metric-v">${t('lp_m_what_3_v')}</div><div class="metric-l">${t('lp_m_what_3_l')}</div></div>
      <div class="metric"><div class="metric-v">${t('lp_m_what_4_v')}</div><div class="metric-l">${t('lp_m_what_4_l')}</div></div>
    </div>
  </div>
</section>

<section class="section tinted">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:start" class="lp-grid">
      <div class="rv" style="position:sticky;top:120px">
        <div class="tag">${t('lp_m_widget_tag')}</div>
        <h2 class="sh">${t('lp_m_widget_h')}</h2>
        <p class="sp" style="margin-top:16px">${t('lp_m_widget_sub')}</p>
        <div style="display:flex;gap:20px;margin-top:32px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" width="16" height="16" opacity=".5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg><span style="font-size:12px;font-weight:600;color:var(--t3)">${t('lp_m_widget_preapproved')}</span></div>
          <div style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" width="16" height="16" opacity=".5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg><span style="font-size:12px;font-weight:600;color:var(--t3)">${t('lp_m_widget_no_check')}</span></div>
          <div style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" width="16" height="16" opacity=".5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg><span style="font-size:12px;font-weight:600;color:var(--t3)">${t('lp_m_widget_no_paperwork')}</span></div>
        </div>
      </div>
      <div class="rv d1">
        <div style="border:1.5px solid rgba(25,68,69,0.06);border-radius:14px;padding:36px 32px;background:var(--bg)">
          <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--t3);margin-bottom:10px">${t('lp_m_widget_salary')}</div>
          <div style="position:relative;margin-bottom:32px">
            <span style="position:absolute;left:0;top:50%;transform:translateY(-50%);font-size:20px;font-weight:600;color:var(--brand);opacity:.3">$</span>
            <input class="onb-input" type="text" inputmode="numeric" id="empWidgetSalary" placeholder="${t('lp_m_widget_salary_ph')}" value="15,000" style="padding-left:20px;font-size:22px;font-weight:600">
            <span style="position:absolute;right:0;top:50%;transform:translateY(-50%);font-size:12px;font-weight:600;color:var(--t3)">MXN</span>
          </div>
          <div style="border-top:1px solid rgba(25,68,69,0.06);padding-top:24px">
            <div style="text-align:center;margin-bottom:24px">
              <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--t3);margin-bottom:4px">${t('lp_m_widget_available')}</div>
              <div id="empWidgetCredit" style="font-family:var(--df);font-size:48px;color:var(--t1);letter-spacing:-.03em">$4,500</div>
              <div style="font-size:11px;color:var(--t3);margin-top:2px">MXN · 30% ${t('lp_m_widget_salary').toLowerCase()}</div>
            </div>
            <div style="border-top:1px solid rgba(25,68,69,0.04);padding-top:16px">
              <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(25,68,69,0.04)">
                <span style="font-size:13px;color:var(--t3)">${t('lp_m_widget_rate')}</span>
                <span style="font-size:13px;font-weight:700;color:var(--t1)">${t('lp_m_widget_rate_val')}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(25,68,69,0.04)">
                <span style="font-size:13px;color:var(--t3)">${t('lp_m_widget_term')}</span>
                <span style="font-size:13px;font-weight:700;color:var(--t1)">${t('lp_m_widget_term_val')}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(25,68,69,0.04)">
                <span style="font-size:13px;color:var(--t3)">${t('lp_m_widget_disbursement')}</span>
                <span style="font-size:13px;font-weight:700;color:var(--t1)">${t('lp_m_widget_disbursement_val')}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(25,68,69,0.04)">
                <span style="font-size:13px;color:var(--t3)">${t('lp_m_widget_deduction')}</span>
                <span id="empWidgetDeduction" style="font-size:13px;font-weight:700;color:var(--t1)">$5,850</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:14px 0">
                <span style="font-family:var(--df);font-size:16px;color:var(--t1)">${t('lp_m_widget_repayment')}</span>
                <span id="empWidgetTotal" style="font-family:var(--df);font-size:20px;color:var(--t1)">$5,850</span>
              </div>
            </div>
          </div>
          <a href="/onboarding" class="hero-cta" onclick="event.preventDefault();navigate('/onboarding',{role:'employee'})" style="display:block;text-align:center;margin-top:20px;width:100%">${t('lp_m_widget_cta')}</a>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section tinted">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid">
      <div class="rv" style="position:sticky;top:120px">
        <div class="tag">${t('lp_m_how_tag')}</div>
        <h2 class="sh">${t('lp_m_how_h')}</h2>
      </div>
      <div class="steps">
        <div class="step rv d1"><div class="step-n">1</div><div><div class="step-title">${t('lp_m_how_1_t')}</div><div class="step-desc">${t('lp_m_how_1_d')}</div></div></div>
        <div class="step rv d2"><div class="step-n">2</div><div><div class="step-title">${t('lp_m_how_2_t')}</div><div class="step-desc">${t('lp_m_how_2_d')}</div></div></div>
        <div class="step rv d3"><div class="step-n">3</div><div><div class="step-title">${t('lp_m_how_3_t')}</div><div class="step-desc">${t('lp_m_how_3_d')}</div></div></div>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="tag rv">${t('lp_m_use_tag')}</div>
    <h2 class="sh rv d1" style="max-width:480px">${t('lp_m_use_h')}</h2>
    <div class="scenario-grid rv d2" style="margin-top:56px">
      <div class="scenario"><div class="scenario-icon r"><svg viewBox="0 0 24 24" fill="none" stroke="#dc503c" stroke-width="1.5" opacity=".6"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="scenario-t">${t('lp_m_use_1_t')}</div><div class="scenario-d">${t('lp_m_use_1_d')}</div><div class="scenario-amt">$3,500</div></div>
      <div class="scenario"><div class="scenario-icon a"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.5" opacity=".6"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg></div><div class="scenario-t">${t('lp_m_use_2_t')}</div><div class="scenario-d">${t('lp_m_use_2_d')}</div><div class="scenario-amt">$4,200</div></div>
      <div class="scenario"><div class="scenario-icon g"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" stroke-width="1.5" opacity=".6"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div><div class="scenario-t">${t('lp_m_use_3_t')}</div><div class="scenario-d">${t('lp_m_use_3_d')}</div><div class="scenario-amt">$5,000</div></div>
      <div class="scenario"><div class="scenario-icon b"><svg viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.5" opacity=".5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/></svg></div><div class="scenario-t">${t('lp_m_use_4_t')}</div><div class="scenario-d">${t('lp_m_use_4_d')}</div><div class="scenario-amt">$2,800</div></div>
    </div>
  </div>
</section>

<section class="section tinted" id="ask">
  <div class="wrap">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid">
      <div class="rv" style="position:sticky;top:120px">
        <div class="tag">${t('lp_m_ask_tag')}</div>
        <h2 class="sh">${t('lp_m_ask_h')}</h2>
        <p class="sp" style="margin-top:16px">${t('lp_m_ask_sub')}</p>
      </div>
      <div class="steps">
        <div class="step rv d1"><div class="step-n">1</div><div><div class="step-title">${t('lp_m_ask_1_t')}</div><div class="step-desc">${t('lp_m_ask_1_d')}</div></div></div>
        <div class="step rv d2"><div class="step-n">2</div><div><div class="step-title">${t('lp_m_ask_2_t')}</div><div class="step-desc">${t('lp_m_ask_2_d')}</div></div></div>
        <div class="step rv d3"><div class="step-n">3</div><div><div class="step-title">${t('lp_m_ask_3_t')}</div><div class="step-desc">${t('lp_m_ask_3_d')}</div></div></div>
      </div>
    </div>
  </div>
</section>

<section class="closing"><div class="closing-glow"></div><h2 class="rv">${t('lp_m_close_h')}</h2><p class="closing-sub rv d1">${t('lp_m_close_sub')}</p><div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;position:relative;z-index:2" class="rv d2"><a href="/onboarding" class="closing-btn" onclick="event.preventDefault();navigate('/onboarding',{role:'employee'})">${t('lp_m_close_cta')}</a><a href="/employers" style="display:inline-block;padding:20px 36px;border-radius:12px;font-size:15px;font-weight:600;color:rgba(255,255,255,0.55);border:1.5px solid rgba(255,255,255,0.15);transition:all .3s;text-align:center" onclick="event.preventDefault();navigate('/employers')">${t('lp_m_close_cta2')}</a></div></section>
${pageFooter()}`;

  initLandingJS();
  initEmployeeWidget();
}

function initEmployeeWidget() {
  const salaryIn = document.getElementById('empWidgetSalary');
  if (!salaryIn) return;
  function update() {
    const raw = parseInt(String(salaryIn.value).replace(/[^0-9]/g, '')) || 0;
    const credit = Math.min(Math.round(raw * 0.30 / 100) * 100, 5000);
    const capped = Math.max(credit, 0);
    const fee = Math.round(capped * 0.30);
    const total = capped + fee;
    const creditEl = document.getElementById('empWidgetCredit');
    const deductionEl = document.getElementById('empWidgetDeduction');
    const totalEl = document.getElementById('empWidgetTotal');
    if (creditEl) creditEl.textContent = '$' + fmt(capped);
    if (deductionEl) deductionEl.textContent = '$' + fmt(total);
    if (totalEl) totalEl.textContent = '$' + fmt(total);
  }
  salaryIn.addEventListener('input', (e) => {
    let raw = e.target.value.replace(/[^0-9]/g, '');
    e.target.value = raw ? fmt(parseInt(raw)) : '';
    update();
  });
  update();
}

function initLandingJS() {
  const burger = document.getElementById('burger'), navMenu = document.getElementById('navMenu'), menuClose = document.getElementById('menuClose');
  if (burger && navMenu) { burger.addEventListener('click', () => { burger.classList.toggle('open'); navMenu.classList.toggle('open'); }); menuClose?.addEventListener('click', () => { burger.classList.remove('open'); navMenu.classList.remove('open'); }); }
  const obs = new IntersectionObserver(e => { e.forEach(x => { if (x.isIntersecting) x.target.classList.add('vis'); }); }, { threshold: .1, rootMargin: '0px 0px -60px 0px' });
  document.querySelectorAll('.rv').forEach(el => obs.observe(el));
  window.scrollTo(0, 0);
}

// ─── SHARED PAGE SHELL ──────────────────────────────────
function pageNav() {
  return `<nav class="nav"><div class="nav-inner"><div class="nav-left"><div class="hamburger" id="burger"><span></span><span></span><span></span></div><a href="/" class="nav-logo" onclick="event.preventDefault();navigate('/')">${vidaLogo()}</a><div class="nav-links"><a href="/employers" onclick="event.preventDefault();navigate('/employers')">${t('nav_employers')}</a><a href="/employees" onclick="event.preventDefault();navigate('/employees')">${t('nav_employees')}</a><a href="/about" onclick="event.preventDefault();navigate('/about')">${t('ft_about')}</a><a href="/contact" onclick="event.preventDefault();navigate('/contact')">${t('nav_contact')}</a></div></div><div class="nav-right"><a href="#" class="nav-lang" onclick="event.preventDefault();toggleLang()">${t('lang_toggle')}</a><a href="/login" class="nav-login" onclick="event.preventDefault();navigate('/login')">${t('nav_login')}</a><a href="/onboarding" class="nav-cta" onclick="event.preventDefault();navigate('/onboarding')">${t('nav_get_started')}</a></div></div></nav>`;
}
function pageFooter() {
  return `<footer class="footer"><div class="footer-inner"><div class="ft-top"><div class="ft-brand"><div class="ft-logo">${vidaLogo('ft')}</div><p class="ft-tag">${t('ft_tagline')}</p></div><div class="ft-col"><div class="ft-h">${t('ft_platform')}</div><a href="/employers" onclick="event.preventDefault();navigate('/employers')">${t('nav_employers')}</a><a href="/employees" onclick="event.preventDefault();navigate('/employees')">${t('nav_employees')}</a><a href="/partners" onclick="event.preventDefault();navigate('/partners')">${t('nav_partners')}</a><a href="/investors" onclick="event.preventDefault();navigate('/investors')">${t('nav_investors')}</a></div><div class="ft-col"><div class="ft-h">${t('ft_company')}</div><a href="/about" onclick="event.preventDefault();navigate('/about')">${t('ft_about')}</a><a href="/security" onclick="event.preventDefault();navigate('/security')">${t('ft_security')}</a><a href="/privacy" onclick="event.preventDefault();navigate('/privacy')">${t('ft_privacy')}</a><a href="/terms" onclick="event.preventDefault();navigate('/terms')">${t('ft_terms')}</a></div><div class="ft-col"><div class="ft-h">${t('ft_connect')}</div><a href="/contact" onclick="event.preventDefault();navigate('/contact')">${t('nav_contact')}</a><a href="https://linkedin.com" target="_blank" rel="noopener">LinkedIn</a><a href="/press" onclick="event.preventDefault();navigate('/press')">${t('ft_press')}</a></div></div><div class="ft-btm"><span>&copy; 2025 VIDA</span><div class="ft-btm-links"><a href="#" onclick="event.preventDefault();toggleLang()">${t('lang_toggle')}</a><a href="/privacy" onclick="event.preventDefault();navigate('/privacy')">${t('ft_privacy_policy')}</a><a href="/terms" onclick="event.preventDefault();navigate('/terms')">${t('ft_terms_service')}</a><span style="color:rgba(255,255,255,.3)">·</span><a href="https://www.condusef.gob.mx" target="_blank" rel="noopener">CONDUSEF</a><span style="color:rgba(255,255,255,.3)">·</span><a href="tel:018009998080">01 800 999 8080</a></div></div></div></footer>`;
}

// ─── ABOUT PAGE ──────────────────────────────────────────
function renderAbout(app) {
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 60px"><div class="hero-blob b1"></div><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_about_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_about_h1')}</h1><p class="hero-sub" style="max-width:520px;margin:0 auto;opacity:0;animation:fu .9s ease .45s forwards">${t('pg_about_sub')}</p></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_about_mission_tag')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid"><div class="rv d1"><h2 class="sh">${t('pg_about_mission_h')}</h2></div><div class="rv d2"><p class="sp" style="font-size:17px;line-height:1.8">${t('pg_about_mission_p')}</p></div></div></div></section>

<section class="section tinted"><div class="wrap"><div class="tag rv">${t('pg_about_struct_tag')}</div><h2 class="sh rv d1">${t('pg_about_struct_h')}</h2><div class="steps" style="margin-top:56px"><div class="step rv d2"><div class="step-n">CH</div><div><div class="step-title">${t('pg_about_struct_1_t')}</div><div class="step-desc">${t('pg_about_struct_1_d')}</div></div></div><div class="step rv d3"><div class="step-n">MX</div><div><div class="step-title">${t('pg_about_struct_2_t')}</div><div class="step-desc">${t('pg_about_struct_2_d')}</div></div></div><div class="step rv d4"><div class="step-n"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div><div><div class="step-title">${t('pg_about_struct_3_t')}</div><div class="step-desc">${t('pg_about_struct_3_d')}</div></div></div></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_about_values_tag')}</div><h2 class="sh rv d1" style="max-width:480px">${t('pg_about_values_h')}</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:56px;border-top:1px solid rgba(25,68,69,0.04)" class="lp-grid"><div class="rv d2" style="padding:40px 40px 40px 0;border-bottom:1px solid rgba(25,68,69,0.04);border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_about_val_1_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_about_val_1_d')}</div></div><div class="rv d3" style="padding:40px 0 40px 40px;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_about_val_2_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_about_val_2_d')}</div></div><div class="rv d4" style="padding:40px 40px 40px 0;border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_about_val_3_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_about_val_3_d')}</div></div><div class="rv d5" style="padding:40px 0 40px 40px"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_about_val_4_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_about_val_4_d')}</div></div></div></div></section>

<section class="closing"><div class="closing-glow"></div><h2 class="rv">${t('close_h2')}</h2><p class="closing-sub rv d1">${t('close_sub')}</p><a href="/onboarding" class="closing-btn rv d2" onclick="event.preventDefault();navigate('/onboarding')">${t('close_cta')}</a></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── SECURITY PAGE ──────────────────────────────────────
function renderSecurity(app) {
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 60px"><div class="hero-blob b1"></div><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_sec_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_sec_h1')}</h1><p class="hero-sub" style="max-width:520px;margin:0 auto;opacity:0;animation:fu .9s ease .45s forwards">${t('pg_sec_sub')}</p></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_sec_enc_tag')}</div><h2 class="sh rv d1">${t('pg_sec_enc_h')}</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:56px;border-top:1px solid rgba(25,68,69,0.04)" class="lp-grid"><div class="rv d2" style="padding:40px 40px 40px 0;border-bottom:1px solid rgba(25,68,69,0.04);border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_enc_1_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_enc_1_d')}</div></div><div class="rv d3" style="padding:40px 0 40px 40px;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_enc_2_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_enc_2_d')}</div></div><div class="rv d4" style="padding:40px 40px 40px 0;border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_enc_3_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_enc_3_d')}</div></div><div class="rv d5" style="padding:40px 0 40px 40px"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_enc_4_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_enc_4_d')}</div></div></div></div></section>

<section class="section tinted"><div class="wrap"><div class="tag rv">${t('pg_sec_infra_tag')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid"><div class="rv d1" style="position:sticky;top:120px"><h2 class="sh">${t('pg_sec_infra_h')}</h2><p class="sp" style="margin-top:16px">${t('pg_sec_infra_p')}</p></div><div class="rv d2"><div class="metrics" style="margin:0"><div class="metric"><div class="metric-v">${t('pg_sec_infra_1_v')}</div><div class="metric-l">${t('pg_sec_infra_1_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_sec_infra_2_v')}</div><div class="metric-l">${t('pg_sec_infra_2_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_sec_infra_3_v')}</div><div class="metric-l">${t('pg_sec_infra_3_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_sec_infra_4_v')}</div><div class="metric-l">${t('pg_sec_infra_4_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_sec_infra_5_v')}</div><div class="metric-l">${t('pg_sec_infra_5_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_sec_infra_6_v')}</div><div class="metric-l">${t('pg_sec_infra_6_l')}</div></div></div></div></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_sec_practices_tag')}</div><h2 class="sh rv d1">${t('pg_sec_practices_h')}</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:56px;border-top:1px solid rgba(25,68,69,0.04)" class="lp-grid"><div class="rv d2" style="padding:40px 40px 40px 0;border-bottom:1px solid rgba(25,68,69,0.04);border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_pr_1_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_pr_1_d')}</div></div><div class="rv d3" style="padding:40px 0 40px 40px;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_pr_2_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_pr_2_d')}</div></div><div class="rv d4" style="padding:40px 40px 40px 0;border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_pr_3_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_pr_3_d')}</div></div><div class="rv d5" style="padding:40px 0 40px 40px"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_sec_pr_4_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_sec_pr_4_d')}</div></div></div></div></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── PRIVACY PAGE ───────────────────────────────────────
function renderPrivacy(app) {
  const sections = [1,2,3,4,5,6,7,8].map(i => `<div class="rv d${i}" style="padding:36px 0;border-bottom:1px solid rgba(25,68,69,0.04)"><h3 style="font-family:var(--df);font-size:22px;color:var(--t1);margin-bottom:12px;letter-spacing:-.02em">${t('pg_priv_'+i+'_t')}</h3><p style="font-size:15px;color:var(--t3);line-height:1.8">${t('pg_priv_'+i+'_p')}</p></div>`).join('');
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 40px"><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_priv_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_priv_h1')}</h1><p style="font-size:13px;color:var(--t3);opacity:0;animation:fu .9s ease .45s forwards">${t('pg_priv_updated')}</p></div></div></section>
<section class="section"><div class="wrap" style="max-width:760px"><p class="rv" style="font-size:16px;color:var(--t2);line-height:1.8;margin-bottom:48px;padding-bottom:36px;border-bottom:1px solid rgba(25,68,69,0.04)">${t('pg_priv_intro')}</p>${sections}</div></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── TERMS PAGE ─────────────────────────────────────────
function renderTerms(app) {
  const sections = [1,2,3,4,5,6,7,8].map(i => `<div class="rv d${i}" style="padding:36px 0;border-bottom:1px solid rgba(25,68,69,0.04)"><h3 style="font-family:var(--df);font-size:22px;color:var(--t1);margin-bottom:12px;letter-spacing:-.02em">${t('pg_terms_'+i+'_t')}</h3><p style="font-size:15px;color:var(--t3);line-height:1.8">${t('pg_terms_'+i+'_p')}</p></div>`).join('');
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 40px"><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_terms_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_terms_h1')}</h1><p style="font-size:13px;color:var(--t3);opacity:0;animation:fu .9s ease .45s forwards">${t('pg_terms_updated')}</p></div></div></section>
<section class="section"><div class="wrap" style="max-width:760px"><p class="rv" style="font-size:16px;color:var(--t2);line-height:1.8;margin-bottom:48px;padding-bottom:36px;border-bottom:1px solid rgba(25,68,69,0.04)">${t('pg_terms_intro')}</p>${sections}</div></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── PARTNERS PAGE ──────────────────────────────────────
function renderPartners(app) {
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 60px"><div class="hero-blob b1"></div><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_part_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_part_h1')}</h1><p class="hero-sub" style="max-width:520px;margin:0 auto 44px;opacity:0;animation:fu .9s ease .45s forwards">${t('pg_part_sub')}</p><div style="opacity:0;animation:fu .9s ease .55s forwards"><a href="/contact" class="hero-cta" onclick="event.preventDefault();navigate('/contact')">${t('pg_part_cta')}</a></div></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_part_who_tag')}</div><h2 class="sh rv d1">${t('pg_part_who_h')}</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:56px;border-top:1px solid rgba(25,68,69,0.04)" class="lp-grid"><div class="rv d2" style="padding:40px 40px 40px 0;border-bottom:1px solid rgba(25,68,69,0.04);border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_part_who_1_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_part_who_1_d')}</div></div><div class="rv d3" style="padding:40px 0 40px 40px;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_part_who_2_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_part_who_2_d')}</div></div><div class="rv d4" style="padding:40px 40px 40px 0;border-right:1px solid rgba(25,68,69,0.04)"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_part_who_3_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_part_who_3_d')}</div></div><div class="rv d5" style="padding:40px 0 40px 40px"><div style="font-size:17px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_part_who_4_t')}</div><div style="font-size:14px;color:var(--t3);line-height:1.6">${t('pg_part_who_4_d')}</div></div></div></div></section>

<section class="section tinted"><div class="wrap"><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid"><div class="rv" style="position:sticky;top:120px"><div class="tag">${t('pg_part_how_tag')}</div><h2 class="sh">${t('pg_part_how_h')}</h2></div><div class="steps"><div class="step rv d1"><div class="step-n">1</div><div><div class="step-title">${t('pg_part_how_1_t')}</div><div class="step-desc">${t('pg_part_how_1_d')}</div></div></div><div class="step rv d2"><div class="step-n">2</div><div><div class="step-title">${t('pg_part_how_2_t')}</div><div class="step-desc">${t('pg_part_how_2_d')}</div></div></div><div class="step rv d3"><div class="step-n">3</div><div><div class="step-title">${t('pg_part_how_3_t')}</div><div class="step-desc">${t('pg_part_how_3_d')}</div></div></div></div></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_part_ben_tag')}</div><h2 class="sh rv d1">${t('pg_part_ben_h')}</h2><div class="metrics rv d2" style="margin-top:48px"><div class="metric"><div class="metric-v">${t('pg_part_ben_1_v')}</div><div class="metric-l">${t('pg_part_ben_1_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_part_ben_2_v')}</div><div class="metric-l">${t('pg_part_ben_2_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_part_ben_3_v')}</div><div class="metric-l">${t('pg_part_ben_3_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_part_ben_4_v')}</div><div class="metric-l">${t('pg_part_ben_4_l')}</div></div></div></div></section>

<section class="closing"><div class="closing-glow"></div><h2 class="rv">${t('pg_part_h1')}</h2><p class="closing-sub rv d1">${t('pg_part_sub')}</p><a href="/contact" class="closing-btn rv d2" onclick="event.preventDefault();navigate('/contact')">${t('pg_part_cta')}</a></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── INVESTORS PAGE ─────────────────────────────────────
function renderInvestors(app) {
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 60px"><div class="hero-blob b1"></div><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_inv_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_inv_h1')}</h1><p class="hero-sub" style="max-width:560px;margin:0 auto 44px;opacity:0;animation:fu .9s ease .45s forwards">${t('pg_inv_sub')}</p><div style="opacity:0;animation:fu .9s ease .55s forwards"><a href="mailto:${t('pg_inv_cta_email')}" class="hero-cta">${t('pg_inv_cta')}</a></div></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_inv_market_tag')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid"><div class="rv d1" style="position:sticky;top:120px"><h2 class="sh">${t('pg_inv_market_h')}</h2><p class="sp" style="margin-top:16px">${t('pg_inv_market_p')}</p></div><div class="rv d2"><div class="metrics" style="margin:0"><div class="metric"><div class="metric-v">${t('pg_inv_market_1_v')}</div><div class="metric-l">${t('pg_inv_market_1_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_inv_market_2_v')}</div><div class="metric-l">${t('pg_inv_market_2_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_inv_market_3_v')}</div><div class="metric-l">${t('pg_inv_market_3_l')}</div></div><div class="metric"><div class="metric-v">${t('pg_inv_market_4_v')}</div><div class="metric-l">${t('pg_inv_market_4_l')}</div></div></div></div></div></div></section>

<section class="section tinted"><div class="wrap"><div class="tag rv">${t('pg_inv_model_tag')}</div><h2 class="sh rv d1">${t('pg_inv_model_h')}</h2><div class="steps" style="margin-top:56px"><div class="step rv d2"><div class="step-n">1</div><div><div class="step-title">${t('pg_inv_model_1_t')}</div><div class="step-desc">${t('pg_inv_model_1_d')}</div></div></div><div class="step rv d3"><div class="step-n">2</div><div><div class="step-title">${t('pg_inv_model_2_t')}</div><div class="step-desc">${t('pg_inv_model_2_d')}</div></div></div><div class="step rv d4"><div class="step-n">3</div><div><div class="step-title">${t('pg_inv_model_3_t')}</div><div class="step-desc">${t('pg_inv_model_3_d')}</div></div></div><div class="step rv d5"><div class="step-n">4</div><div><div class="step-title">${t('pg_inv_model_4_t')}</div><div class="step-desc">${t('pg_inv_model_4_d')}</div></div></div></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_inv_gov_tag')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid"><div class="rv d1"><h2 class="sh">${t('pg_inv_gov_h')}</h2></div><div class="rv d2"><p class="sp" style="font-size:17px;line-height:1.8">${t('pg_inv_gov_p')}</p></div></div></div></section>

<section class="closing"><div class="closing-glow"></div><h2 class="rv">${t('pg_inv_h1')}</h2><p class="closing-sub rv d1" style="margin-bottom:20px">${t('pg_inv_sub')}</p><a href="mailto:${t('pg_inv_cta_email')}" class="closing-btn rv d2">${t('pg_inv_cta')}</a><p class="rv d3" style="font-size:13px;color:rgba(255,255,255,0.35);margin-top:16px;position:relative;z-index:2">${t('pg_inv_cta_email')}</p></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── CONTACT PAGE ───────────────────────────────────────
function renderContact(app) {
  const emailRow = (label, email) => `<div style="padding:20px 0;border-bottom:1px solid rgba(25,68,69,0.04);display:flex;justify-content:space-between;align-items:center"><span style="font-size:14px;color:var(--t3)">${label}</span><a href="mailto:${email}" style="font-size:14px;font-weight:600;color:var(--t1);border-bottom:1px solid rgba(25,68,69,0.12);padding-bottom:1px">${email}</a></div>`;
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 60px"><div class="hero-blob b1"></div><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_contact_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_contact_h1')}</h1><p class="hero-sub" style="max-width:520px;margin:0 auto;opacity:0;animation:fu .9s ease .45s forwards">${t('pg_contact_sub')}</p></div></div></section>

<section class="section"><div class="wrap"><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid">
<div>
  <div class="rv" style="margin-bottom:48px">
    ${emailRow(t('pg_contact_general_t'), t('pg_contact_general_v'))}
    ${emailRow(t('pg_contact_employers_t'), t('pg_contact_employers_v'))}
    ${emailRow(t('pg_contact_press_t'), t('pg_contact_press_v'))}
    ${emailRow(t('pg_contact_investors_t'), t('pg_contact_investors_v'))}
    ${emailRow(t('pg_contact_privacy_t'), t('pg_contact_privacy_v'))}
  </div>
  <div class="tag rv d1">${t('pg_contact_office_tag')}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:36px;margin-top:24px" class="rv d2">
    <div><div style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_contact_office_mx_t')}</div><div style="font-size:13px;color:var(--t3);line-height:1.7">${t('pg_contact_office_mx_d')}</div></div>
    <div><div style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:6px">${t('pg_contact_office_ch_t')}</div><div style="font-size:13px;color:var(--t3);line-height:1.7">${t('pg_contact_office_ch_d')}</div></div>
  </div>
</div>
<div class="rv d2">
  <form id="contactForm" style="border-top:1px solid rgba(25,68,69,0.04);padding-top:36px">
    <div style="margin-bottom:24px"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--t3);margin-bottom:8px">${t('pg_contact_form_name')}</div><input class="onb-input" type="text" id="cfName" placeholder="${t('pg_contact_form_name_ph')}" required></div>
    <div style="margin-bottom:24px"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--t3);margin-bottom:8px">${t('pg_contact_form_email')}</div><input class="onb-input" type="email" id="cfEmail" placeholder="${t('pg_contact_form_email_ph')}" required></div>
    <div style="margin-bottom:24px"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--t3);margin-bottom:8px">${t('pg_contact_form_type')}</div><select class="onb-select" id="cfType" style="width:100%;padding:16px 0;border:none;border-bottom:1.5px solid rgba(25,68,69,0.08);background:transparent;font-size:16px;color:var(--t1);font-family:var(--db)"><option value="general">${t('pg_contact_form_type_general')}</option><option value="employer">${t('pg_contact_form_type_employer')}</option><option value="partner">${t('pg_contact_form_type_partner')}</option><option value="investor">${t('pg_contact_form_type_investor')}</option><option value="press">${t('pg_contact_form_type_press')}</option><option value="other">${t('pg_contact_form_type_other')}</option></select></div>
    <div style="margin-bottom:32px"><div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--t3);margin-bottom:8px">${t('pg_contact_form_msg')}</div><textarea class="onb-input" id="cfMsg" placeholder="${t('pg_contact_form_msg_ph')}" rows="4" style="resize:vertical;min-height:100px" required></textarea></div>
    <button type="submit" class="btn-primary" id="cfBtn" style="width:100%">${t('pg_contact_form_send')}</button>
    <div id="cfSuccess" style="display:none;text-align:center;padding:20px 0;color:var(--brand);font-weight:600;font-size:14px">${t('pg_contact_form_sent')}</div>
  </form>
</div>
</div></div></section>
${pageFooter()}`;

  initLandingJS();
  const form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('cfBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        await db.collection('contacts').add({
          name: document.getElementById('cfName').value,
          email: document.getElementById('cfEmail').value,
          type: document.getElementById('cfType').value,
          message: document.getElementById('cfMsg').value,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        form.style.display = 'none';
        document.getElementById('cfSuccess').style.display = 'block';
      } catch (err) {
        btn.disabled = false;
        btn.textContent = t('pg_contact_form_send');
        showToast(err.message, 'error');
      }
    });
  }
}

// ─── PRESS PAGE ─────────────────────────────────────────
function renderPress(app) {
  app.innerHTML = `${pageNav()}
<section class="hero" style="padding:100px 0 60px"><div class="hero-blob b1"></div><div class="hero-inner" style="grid-template-columns:1fr;text-align:center;max-width:720px;margin:0 auto"><div class="hero-text" style="text-align:center"><div class="hero-badge" style="justify-content:center"><span class="badge-dot"></span><span class="badge-text">${t('pg_press_badge')}</span></div><h1 style="font-family:var(--df);font-size:72px;color:var(--t1);line-height:.96;letter-spacing:-.045em;margin-bottom:24px;opacity:0;animation:fu .9s ease .3s forwards">${t('pg_press_h1')}</h1><p class="hero-sub" style="max-width:520px;margin:0 auto;opacity:0;animation:fu .9s ease .45s forwards">${t('pg_press_sub')}</p></div></div></section>

<section class="section"><div class="wrap"><div class="tag rv">${t('pg_press_kit_tag')}</div><h2 class="sh rv d1">${t('pg_press_kit_h')}</h2><div class="steps" style="margin-top:56px"><div class="step rv d2"><div class="step-n"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></div><div><div class="step-title">${t('pg_press_kit_1_t')}</div><div class="step-desc">${t('pg_press_kit_1_d')}</div></div></div><div class="step rv d3"><div class="step-n"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg></div><div><div class="step-title">${t('pg_press_kit_2_t')}</div><div class="step-desc">${t('pg_press_kit_2_d')}</div></div></div><div class="step rv d4"><div class="step-n"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div><div class="step-title">${t('pg_press_kit_3_t')}</div><div class="step-desc">${t('pg_press_kit_3_d')}</div></div></div></div></div></section>

<section class="section tinted"><div class="wrap"><div style="display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:start" class="lp-grid"><div class="rv"><div class="tag">${t('pg_press_contact_tag')}</div><p class="sp" style="margin-top:8px">${t('pg_press_contact_p')}</p><a href="mailto:${t('pg_press_contact_email')}" style="display:inline-block;margin-top:16px;font-size:17px;font-weight:700;color:var(--t1);border-bottom:2px solid var(--brand);padding-bottom:2px">${t('pg_press_contact_email')}</a></div><div class="rv d1"><div class="tag">${t('pg_press_brand_tag')}</div><h2 class="sh" style="margin-bottom:36px">${t('pg_press_brand_h')}</h2><div style="border-top:1px solid rgba(25,68,69,0.04)"><div style="padding:24px 0;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:4px">${t('pg_press_brand_1_t')}</div><div style="font-size:13px;color:var(--t3);line-height:1.6">${t('pg_press_brand_1_d')}</div></div><div style="padding:24px 0;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:4px">${t('pg_press_brand_2_t')}</div><div style="font-size:13px;color:var(--t3);line-height:1.6">${t('pg_press_brand_2_d')}</div><div style="display:flex;gap:8px;margin-top:8px"><span style="width:32px;height:32px;border-radius:8px;background:#194445;display:block"></span><span style="font-size:11px;color:var(--t3);align-self:center">#194445</span></div></div><div style="padding:24px 0;border-bottom:1px solid rgba(25,68,69,0.04)"><div style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:4px">${t('pg_press_brand_3_t')}</div><div style="font-size:13px;color:var(--t3);line-height:1.6">${t('pg_press_brand_3_d')}</div><div style="display:flex;gap:8px;margin-top:8px"><span style="width:32px;height:32px;border-radius:8px;background:#C9A84C;display:block"></span><span style="font-size:11px;color:var(--t3);align-self:center">#C9A84C</span></div></div><div style="padding:24px 0"><div style="font-size:15px;font-weight:700;color:var(--t1);margin-bottom:4px">${t('pg_press_brand_4_t')}</div><div style="font-size:13px;color:var(--t3);line-height:1.6">${t('pg_press_brand_4_d')}</div></div></div></div></div></div></section>
${pageFooter()}`;
  initLandingJS();
}

// ─── LOGIN PAGE ──────────────────────────────────────────
function renderLogin(app) {
  app.innerHTML = `<div class="auth-page"><div class="auth-card"><div class="nav-logo">${vidaLogo()}</div><h2>${t('auth_welcome')}</h2><p class="auth-sub">${t('auth_signin_sub')}</p><div class="auth-error" id="authError"></div><form id="loginForm"><div class="form-group"><label>${t('auth_email')}</label><input type="email" id="loginEmail" placeholder="${t('auth_email_placeholder')}" required></div><div class="form-group"><label>${t('auth_password')}</label><input type="password" id="loginPass" placeholder="${t('auth_password_placeholder')}" required></div><button type="submit" class="btn-primary" id="loginBtn">${t('auth_signin_btn')}</button></form><p class="auth-footer">${t('auth_no_account')} <a href="/onboarding" onclick="event.preventDefault();navigate('/onboarding')">${t('auth_signup_link')}</a></p><p class="auth-footer" style="margin-top:12px"><a href="#" onclick="event.preventDefault();toggleLang()" style="color:var(--t3)">${t('lang_toggle')}</a></p></div></div>`;
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const btn = document.getElementById('loginBtn'); const errEl = document.getElementById('authError');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + t('auth_signing_in'); errEl.classList.remove('show');
    try {
      await auth.signInWithEmailAndPassword(document.getElementById('loginEmail').value, document.getElementById('loginPass').value);
      if (!auth.currentUser.emailVerified) {
        await auth.currentUser.sendEmailVerification();
        errEl.textContent = 'Verifica tu correo electrónico. Te enviamos un enlace de verificación.';
        errEl.classList.add('show');
        errEl.style.background = '#fff8e1'; errEl.style.color = '#8d6e00';
        btn.disabled = false; btn.textContent = t('auth_signin_btn');
        await auth.signOut();
        return;
      }
    }
    catch (err) { errEl.textContent = err.message; errEl.classList.add('show'); btn.disabled = false; btn.textContent = t('auth_signin_btn'); }
  });
}

// ─── DOC UPLOAD BANNER (pending_verification + no docs) ─
function renderDocUploadBanner(app, uid) {
  const docSlots = [
    { key: 'rfc', field: 'docRFC', i18n: 'onb_e_step4_rfc' },
    { key: 'id_oficial', field: 'docId', i18n: 'onb_e_step4_id' },
    { key: 'comprobante', field: 'docAddress', i18n: 'onb_e_step4_address' },
  ];
  const uploaded = {};

  function renderBanner() {
    const rows = docSlots.map(s => {
      const done = !!uploaded[s.key];
      const iconBg = done ? 'rgba(36,122,110,0.12)' : 'rgba(201,168,76,0.12)';
      const iconStroke = done ? '#247a6e' : '#c9a84c';
      const icon = done
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="${iconStroke}" stroke-width="2.5" style="width:16px;height:16px"><path d="M20 6L9 17l-5-5"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="${iconStroke}" stroke-width="2" style="width:16px;height:16px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`;
      const btnStyle = done
        ? 'background:rgba(36,122,110,0.12);color:#247a6e;cursor:default'
        : 'background:var(--brand);color:#fff;cursor:pointer';
      const btnLabel = done ? t('onb_e_step4_done') : t('onb_e_step4_upload');
      return `<div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:12px;padding:16px;border:1px solid rgba(25,68,69,0.08)">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          <div style="width:32px;height:32px;border-radius:50%;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0">${icon}</div>
          <div style="min-width:0"><div style="font-size:13px;font-weight:600;color:var(--t1)">${t(s.i18n)}</div><div style="font-size:11px;color:var(--t3)">${t('onb_e_step4_formats')}</div></div>
        </div>
        <label style="display:inline-block;padding:8px 16px;border-radius:8px;font-size:12px;font-weight:600;${btnStyle};transition:all .2s" class="doc-upload-label" data-key="${s.key}">
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf" style="display:none" data-key="${s.key}" class="doc-file-input" ${done ? 'disabled' : ''}>${btnLabel}
        </label>
      </div>`;
    }).join('');

    app.innerHTML = `<div style="max-width:640px;margin:48px auto;padding:0 16px">
      <div style="background:rgba(201,168,76,0.12);border-radius:16px;padding:32px">
        <h2 style="font-size:20px;font-weight:700;color:var(--brand);margin:0 0 8px">${t('dash_doc_banner_h')}</h2>
        <p style="font-size:14px;color:var(--t2);margin:0 0 24px">${t('dash_doc_banner_sub')}</p>
        <div style="display:flex;flex-direction:column;gap:16px">${rows}</div>
      </div>
    </div>`;

    // Bind file inputs
    app.querySelectorAll('.doc-file-input').forEach(input => {
      if (uploaded[input.dataset.key]) return;
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const key = input.dataset.key;
        if (file.size > 5 * 1024 * 1024) return;
        const label = app.querySelector(`.doc-upload-label[data-key="${key}"]`);
        label.textContent = t('onb_e_step4_uploading');
        label.style.opacity = '0.6';
        try {
          const ref = storage.ref(`onboarding/employer_docs/${uid}/${key}`);
          const task = ref.put(file);
          await new Promise((resolve, reject) => {
            task.on('state_changed', null, reject, resolve);
          });
          uploaded[key] = await task.snapshot.ref.getDownloadURL();
          renderBanner();
          // If all 3 uploaded, save to Firestore
          if (Object.keys(uploaded).length === 3) {
            await db.collection('employers').doc(uid).update({
              docRFC: uploaded.rfc,
              docId: uploaded.id_oficial,
              docAddress: uploaded.comprobante,
            });
            app.innerHTML = `<div style="max-width:480px;margin:80px auto;text-align:center;padding:40px">
              <div style="width:64px;height:64px;border-radius:50%;background:rgba(36,122,110,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
                <svg viewBox="0 0 24 24" fill="none" stroke="#247a6e" stroke-width="2.5" style="width:32px;height:32px"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <h2 style="font-size:20px;font-weight:700;color:var(--brand);margin:0">${t('dash_doc_banner_success')}</h2>
            </div>`;
            setTimeout(() => renderEmployerDashboard(app), 3000);
          }
        } catch (err) {
          label.textContent = t('onb_e_step4_error');
          label.style.opacity = '1';
          label.style.background = 'rgba(220,80,60,0.12)';
          label.style.color = '#dc503c';
        }
      });
    });
  }

  renderBanner();
}

// ─── EMPLOYER DASHBOARD ──────────────────────────────────
async function renderEmployerDashboard(app) {
  app.innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  if (!auth.currentUser?.emailVerified) {
    app.innerHTML = '<div style="max-width:600px;margin:80px auto;text-align:center;padding:40px"><h2>Verifica tu correo electrónico</h2><p style="margin:16px 0;color:var(--t2)">Te enviamos un enlace de verificación. Revisa tu bandeja de entrada y vuelve a iniciar sesión.</p><button class="btn-primary" onclick="auth.signOut().then(()=>navigate(\'/login\'))">Volver al inicio</button></div>';
    return;
  }
  const uid = auth.currentUser.uid;
  const empDoc = await db.collection('employers').doc(uid).get();
  if (!empDoc.exists) { navigate('/employee/dashboard'); return; }
  const emp = empDoc.data();
  if (emp.status === 'pending_verification') {
    if (!emp.docRFC) {
      renderDocUploadBanner(app, uid);
      return;
    }
    app.innerHTML = `<div class="onb"><div class="onb-blob ob1"></div><div class="onb-blob ob2"></div><div class="onb-top"><span class="onb-logo">${vidaLogo()}</span></div><div class="onb-body"><div class="onb-stage active"><div class="onb-content"><div class="onb-celebration"><div class="onb-check-circle" style="background:rgba(162,134,87,0.12)"><svg viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div><div class="onb-approved-tag"><span class="onb-approved-dot" style="background:var(--gold)"></span>${currentLang==='es'?'Verificación en proceso':'Verification in progress'}</div><h1 class="onb-h">${currentLang==='es'?'¡Cuenta<br><em>creada</em>!':'Account<br><em>created</em>!'}</h1><p class="onb-sub">${currentLang==='es'?'Nuestro equipo revisará tus documentos en 24–48 horas hábiles.':'Our team will review your documents within 24–48 business hours.'}</p><button class="onb-btn" onclick="auth.signOut().then(()=>navigate('/'))">${currentLang==='es'?'Ir al inicio':'Go to home'}</button></div></div></div></div></div>`;
    return;
  }
  if (emp.status && emp.status !== 'active' && emp.status !== 'pending_verification') { navigate('/'); return; }

  // Fetch dashboard data from Cloud Function
  let dashData = null;
  try {
    const fn = firebase.functions().httpsCallable('getEmployerDashboard');
    const result = await fn({});
    dashData = result.data;
  } catch (_) { /* fallback to local data */ }

  const stats = dashData?.stats || {};
  let allLoans = [], currentTab = 'all';
  if (window._unsubDash) window._unsubDash();

  function renderDashShell() {
    const pending = allLoans.filter(l => l.status === 'pending').length;
    const active = allLoans.filter(l => l.status === 'approved' || l.status === 'active').length;
    const totalDisbursed = stats.totalDisbursed || allLoans.filter(l => l.status !== 'rejected' && l.status !== 'pending').reduce((s, l) => s + l.amount, 0);
    app.innerHTML = `<div class="dash"><aside class="dash-side"><div class="nav-logo">${vidaLogo()}</div><nav class="dash-nav">${ehrNavItems('dashboard')}</nav><button class="dash-logout" onclick="auth.signOut().then(()=>navigate('/'))"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>${t('dash_signout')}</button></aside><div class="dash-main"><div class="dash-header"><h1>${emp.companyName}</h1><div class="dash-user"><span>${t('dash_employer_code')}: <strong>${emp.employerCode}</strong></span><a href="#" onclick="event.preventDefault();toggleLang()" style="font-size:12px;font-weight:600;color:var(--brand);margin-left:12px">${t('lang_toggle')}</a><div class="dash-avatar">${emp.name?.charAt(0)||'E'}</div></div></div><div class="dash-content"><div class="stat-grid"><div class="stat-card"><div class="stat-label">${t('ehr_total_employees')}</div><div class="stat-value">${stats.totalEmployees || emp.totalEmployees || 0}</div></div><div class="stat-card"><div class="stat-label">${t('ehr_active_loans')}</div><div class="stat-value">${stats.activeLoans || active}</div></div><div class="stat-card"><div class="stat-label">${t('ehr_overdue_count')}</div><div class="stat-value">${stats.overdueCount || 0}</div></div><div class="stat-card"><div class="stat-label">${t('ehr_total_disbursed')}</div><div class="stat-value">$${fmt(totalDisbursed)}</div><div class="stat-change">MXN</div></div><div class="stat-card"><div class="stat-label">${t('ehr_adoption_rate')}</div><div class="stat-value">${stats.adoptionRate || '0%'}</div></div><div class="stat-card"><div class="stat-label">${t('ehr_outstanding')}</div><div class="stat-value">$${fmt(stats.outstandingBalance || 0)}</div><div class="stat-change">MXN</div></div></div>${renderUpcomingDeductions(dashData?.upcomingDeductions)}<div id="dashTabContent"></div></div></div></div>`;
    renderLoanTable(allLoans, currentTab);
    ehrBindNav();
  }

  window._unsubDash = db.collection('loans')
    .where('employerId','==',uid).orderBy('createdAt','desc')
    .onSnapshot(snap => {
      allLoans = snap.docs.map(d => ({id:d.id,...d.data()}));
      renderDashShell();
    });

  function renderUpcomingDeductions(deductions) {
    if (!deductions || !deductions.length) return '';
    return `<div class="card" style="margin-bottom:24px"><div class="card-title">${t('ehr_upcoming_deductions')}</div><div class="table-wrap"><table><thead><tr><th>${t('ehr_th_employee_id')}</th><th>${t('ehr_th_amount')}</th><th>${t('ehr_th_due_date')}</th><th>${t('ehr_th_loan_id')}</th></tr></thead><tbody>${deductions.map(d => `<tr><td style="font-size:12px">${d.employeeId||'—'}</td><td>$${fmt(d.amount||0)}</td><td>${d.dueDate ? (d.dueDate.seconds ? new Date(d.dueDate.seconds*1000).toLocaleDateString() : new Date(d.dueDate).toLocaleDateString()) : '—'}</td><td style="font-size:12px;color:var(--t3)">${d.loanId||'—'}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function renderLoanTable(loans, tab) {
    currentTab = tab;
    const tabLabels = [
      {key:'all',       es:'Todos',       en:'All'},
      {key:'pending',   es:'Pendientes',  en:'Pending'},
      {key:'approved',  es:'Aprobados',   en:'Approved'},
      {key:'active',    es:'Activos',     en:'Active'},
      {key:'paid',      es:'Completados', en:'Completed'},
      {key:'rejected',  es:'Rechazados',  en:'Rejected'}
    ];
    let filtered;
    if (tab === 'all') filtered = loans;
    else if (tab === 'approved') filtered = loans.filter(l => l.status === 'approved' || l.status === 'disbursement_queued');
    else filtered = loans.filter(l => l.status === tab);

    const tabsHtml = `<div class="dash-tabs" style="display:flex;gap:0;border-bottom:1px solid rgba(25,68,69,0.08);margin-bottom:20px">${tabLabels.map(tb => `<button class="dash-tab-btn${tb.key===tab?' dash-tab-active':''}" data-tab="${tb.key}" style="padding:10px 16px;font-size:13px;font-weight:${tb.key===tab?'700':'500'};color:${tb.key===tab?'var(--brand)':'var(--t3)'};background:none;border:none;border-bottom:${tb.key===tab?'2px solid var(--brand)':'2px solid transparent'};cursor:pointer;transition:all .2s">${currentLang==='es'?tb.es:tb.en}${tb.key!=='all'?' ('+loans.filter(l=>{if(tb.key==='approved')return l.status==='approved'||l.status==='disbursement_queued';return l.status===tb.key}).length+')':' ('+loans.length+')'}</button>`).join('')}</div>`;

    const tableHtml = filtered.length ? `<table><thead><tr><th>${t('dash_th_employee')}</th><th>${t('dash_th_amount')}</th><th>${t('dash_th_term')}</th><th>${t('dash_th_status')}</th><th>${t('dash_th_docs')}</th><th>${t('dash_th_action')}</th></tr></thead><tbody>${filtered.map(l=>`<tr><td>${l.employeeName}</td><td>$${fmt(l.amount)}</td><td>${l.termDays} ${t('dash_days')}</td><td><span class="badge badge-${l.status}">${t('status_'+l.status)}</span></td><td>${renderDocLinks(l)}</td><td>${l.status==='pending'?`<button class="btn-sm btn-approve" onclick="approveLoan('${l.id}',this)">${t('dash_approve')}</button> <button class="btn-sm btn-reject" onclick="rejectLoan('${l.id}',this)">${t('dash_reject')}</button>`:'—'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg><p>${t('dash_no_loans_employer')} <strong>${emp.employerCode}</strong> ${t('dash_no_loans_employer_2')}</p></div>`;

    const container = document.getElementById('dashTabContent');
    if (container) {
      container.innerHTML = `<div class="card"><div class="card-title">${t('dash_recent_loans')}</div>${tabsHtml}<div class="table-wrap">${tableHtml}</div></div>`;
      container.querySelectorAll('.dash-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => renderLoanTable(allLoans, btn.dataset.tab));
      });
    }
  }
}

// ─── Employer HR Nav Helper ─────────────────────────────
function ehrNavItems(activeTab) {
  const items = [
    { key: 'dashboard', path: '/employer/dashboard', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>', label: 'ehr_overview' },
    { key: 'employees', path: '/employer/employees', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>', label: 'ehr_employees' },
    { key: 'deductions', path: '/employer/deductions', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>', label: 'ehr_deductions' },
    { key: 'onboarding', path: '/employer/onboarding', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg>', label: 'ehr_onboarding' },
    { key: 'analytics', path: '/employer/analytics', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>', label: 'ehr_analytics' },
  ];
  return items.map(i => `<a href="${i.path}" class="dash-nav-link${i.key === activeTab ? ' active' : ''}">${i.icon}${t(i.label)}</a>`).join('');
}

function ehrBindNav() {
  document.querySelectorAll('.dash-nav-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) navigate(href);
    });
  });
}

// ─── EMPLOYER HR PAGES ──────────────────────────────────
async function renderEmployerHR(app, tab) {
  app.innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  if (!auth.currentUser) { navigate('/login'); return; }
  const uid = auth.currentUser.uid;
  const empDoc = await db.collection('employers').doc(uid).get();
  if (!empDoc.exists) { navigate('/employee/dashboard'); return; }
  const emp = empDoc.data();

  function shell(content) {
    return `<div class="dash"><aside class="dash-side"><div class="nav-logo">${vidaLogo()}</div><nav class="dash-nav">${ehrNavItems(tab)}</nav><button class="dash-logout" onclick="auth.signOut().then(()=>navigate('/'))"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>${t('dash_signout')}</button></aside><div class="dash-main"><div class="dash-header"><h1>${emp.companyName}</h1><div class="dash-user"><span>${t('dash_employer_code')}: <strong>${emp.employerCode}</strong></span><a href="#" onclick="event.preventDefault();toggleLang()" style="font-size:12px;font-weight:600;color:var(--brand);margin-left:12px">${t('lang_toggle')}</a><div class="dash-avatar">${emp.name?.charAt(0)||'E'}</div></div></div><div class="dash-content">${content}</div></div></div>`;
  }

  if (tab === 'employees') await renderEhrEmployees(app, uid, emp, shell);
  else if (tab === 'deductions') await renderEhrDeductions(app, uid, emp, shell);
  else if (tab === 'onboarding') await renderEhrOnboarding(app, uid, emp, shell);
  else if (tab === 'analytics') await renderEhrAnalytics(app, uid, emp, shell);

  ehrBindNav();
}

// ─── Employee Roster ────────────────────────────────────
async function renderEhrEmployees(app, uid, emp, shell) {
  app.innerHTML = shell('<div style="padding:40px;text-align:center"><span class="spinner" style="border-color:rgba(25,68,69,0.1);border-top-color:var(--brand)"></span></div>');
  ehrBindNav();

  const [empSnap, loanSnap] = await Promise.all([
    db.collection('employers').doc(uid).collection('employees').get(),
    db.collection('loans').where('employerId', '==', uid).where('status', 'in', ['active', 'disbursed']).get()
  ]);

  const loansByEmployee = {};
  loanSnap.docs.forEach(d => {
    const l = d.data();
    const eid = l.userId || l.employeeId;
    if (eid) loansByEmployee[eid] = (loansByEmployee[eid] || 0) + 1;
  });

  const employees = empSnap.docs.map(d => {
    const data = d.data();
    return { id: d.id, ...data, activeLoans: loansByEmployee[d.id] || 0 };
  });

  function renderTable(filter, query) {
    let filtered = employees;
    if (filter === 'active') filtered = filtered.filter(e => e.active !== false);
    else if (filter === 'inactive') filtered = filtered.filter(e => e.active === false);
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(e => (e.name||'').toLowerCase().includes(q) || (e.email||'').toLowerCase().includes(q));
    }

    const filterBtns = ['all','active','inactive'].map(f => `<button class="ehr-filter-btn${f===filter?' active':''}" data-filter="${f}">${t('ehr_emp_filter_'+f)}</button>`).join('');
    const tableHtml = filtered.length ? `<table><thead><tr><th>${t('dash_emp_name')}</th><th>${t('dash_emp_email')}</th><th>${t('ehr_emp_status')}</th><th>${t('ehr_emp_credit')}</th><th>${t('ehr_emp_loans')}</th><th>${t('dash_emp_registered')}</th></tr></thead><tbody>${filtered.map(e => `<tr><td>${e.name||'—'}</td><td>${e.email||'—'}</td><td><span class="badge ${e.active !== false ? 'badge-active' : 'badge-rejected'}">${e.active !== false ? t('ehr_emp_active') : t('ehr_emp_inactive')}</span></td><td>$${fmt(e.availableCredit||e.creditLimit||0)}</td><td>${e.activeLoans}</td><td>${e.createdAt ? new Date((e.createdAt.seconds||0)*1000).toLocaleDateString() : '—'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>${t('ehr_no_employees')}</p></div>`;

    const content = `<div class="card"><div class="card-title">${t('ehr_employees')} <span style="font-size:13px;font-weight:400;color:var(--t3);margin-left:8px">(${employees.length})</span></div><div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap"><input type="text" id="ehrEmpSearch" placeholder="${t('ehr_emp_search')}" value="${query||''}" style="flex:1;min-width:200px;max-width:320px;padding:10px 14px;border:1px solid rgba(25,68,69,0.1);border-radius:8px;font-size:13px;outline:none"><div class="ehr-filter-group">${filterBtns}</div></div><div class="table-wrap">${tableHtml}</div></div>`;

    const container = document.querySelector('.dash-content');
    if (container) {
      container.innerHTML = content;
      document.getElementById('ehrEmpSearch')?.addEventListener('input', (e) => renderTable(filter, e.target.value));
      container.querySelectorAll('.ehr-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => renderTable(btn.dataset.filter, document.getElementById('ehrEmpSearch')?.value));
      });
    }
  }

  app.innerHTML = shell('');
  ehrBindNav();
  renderTable('all', '');
}

// ─── Deductions Report ──────────────────────────────────
async function renderEhrDeductions(app, uid, emp, shell) {
  app.innerHTML = shell('<div style="padding:40px;text-align:center"><span class="spinner" style="border-color:rgba(25,68,69,0.1);border-top-color:var(--brand)"></span></div>');
  ehrBindNav();

  const loansSnap = await db.collection('loans')
    .where('employerId', '==', uid)
    .where('status', 'in', ['active', 'disbursed', 'paid', 'overdue'])
    .orderBy('dueDate', 'desc')
    .get();

  const allDeductions = loansSnap.docs.map(d => {
    const l = d.data();
    const due = l.dueDate ? new Date((l.dueDate.seconds||0)*1000) : null;
    let dedStatus = 'pending';
    if (l.status === 'paid') dedStatus = 'deducted';
    else if (l.status === 'overdue') dedStatus = 'missed';
    return {
      id: d.id, employeeName: l.employeeName || l.userId || '—',
      amount: l.totalRepaymentAmount || l.repaymentAmount || l.amount || 0,
      dueDate: due, status: dedStatus, loanId: l.loanId || d.id,
      month: due ? due.toISOString().slice(0,7) : 'unknown'
    };
  });

  const now = new Date();
  const currentMonth = now.toISOString().slice(0,7);
  const currentDeductions = allDeductions.filter(d => d.month === currentMonth);
  let activeView = 'current';

  function render() {
    const deductions = activeView === 'current' ? currentDeductions : allDeductions;
    const statusBadge = (s) => {
      if (s === 'deducted') return `<span class="badge badge-active">${t('ehr_ded_deducted')}</span>`;
      if (s === 'missed') return `<span class="badge badge-overdue">${t('ehr_ded_missed')}</span>`;
      return `<span class="badge badge-pending">${t('ehr_ded_pending')}</span>`;
    };

    const tableHtml = deductions.length ? `<table><thead><tr><th>${t('ehr_ded_employee')}</th><th>${t('ehr_ded_amount')}</th><th>${t('ehr_ded_due')}</th><th>${t('ehr_ded_status')}</th><th>${t('ehr_ded_loan')}</th></tr></thead><tbody>${deductions.map(d => `<tr><td>${d.employeeName}</td><td>$${fmt(d.amount)}</td><td>${d.dueDate ? d.dueDate.toLocaleDateString() : '—'}</td><td>${statusBadge(d.status)}</td><td style="font-size:12px;color:var(--t3)">${d.loanId}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state"><p>${activeView === 'current' ? t('ehr_no_deductions') : t('ehr_no_deductions_hist')}</p></div>`;

    const content = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px"><div class="card-title" style="margin-bottom:0">${t('ehr_deductions')}</div><button class="btn-sm btn-approve" id="ehrDedExport" style="font-size:12px">${t('ehr_ded_export')}</button></div><div class="ehr-filter-group" style="margin-bottom:16px"><button class="ehr-filter-btn${activeView==='current'?' active':''}" data-view="current">${t('ehr_ded_current')}</button><button class="ehr-filter-btn${activeView==='history'?' active':''}" data-view="history">${t('ehr_ded_history')}</button></div><div class="table-wrap">${tableHtml}</div></div>`;

    const container = document.querySelector('.dash-content');
    if (container) {
      container.innerHTML = content;
      container.querySelectorAll('.ehr-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => { activeView = btn.dataset.view; render(); });
      });
      document.getElementById('ehrDedExport')?.addEventListener('click', () => {
        const data = activeView === 'current' ? currentDeductions : allDeductions;
        const header = [t('ehr_ded_employee'), t('ehr_ded_amount'), t('ehr_ded_due'), t('ehr_ded_status'), t('ehr_ded_loan')].join(',');
        const rows = data.map(d => [
          '"' + (d.employeeName||'').replace(/"/g,'""') + '"',
          d.amount,
          d.dueDate ? d.dueDate.toISOString().split('T')[0] : '',
          d.status,
          d.loanId
        ].join(','));
        const csv = header + '\n' + rows.join('\n');
        const a = document.createElement('a');
        a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
        a.download = 'deductions_' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
      });
    }
  }

  app.innerHTML = shell('');
  ehrBindNav();
  render();
}

// ─── Employer Onboarding Wizard ─────────────────────────
async function renderEhrOnboarding(app, uid, emp, shell) {
  let step = emp.onboardingStep || 0;
  if (emp.status === 'active' && step >= 4) step = 4; // completed

  function render() {
    let stepContent = '';
    const progressPct = Math.min(((step + 1) / 4) * 100, 100);
    const progressBar = `<div class="ehr-wizard-progress"><div class="ehr-wizard-progress-fill" style="width:${progressPct}%"></div></div><div class="ehr-wizard-steps"><span class="${step>=0?'active':''}">1</span><span class="${step>=1?'active':''}">2</span><span class="${step>=2?'active':''}">3</span><span class="${step>=3?'active':''}">4</span></div>`;

    if (step === 0) {
      stepContent = `<div class="ehr-wizard-card"><h2 class="ehr-wizard-h">${t('ehr_onb_step1_h')}</h2><p class="ehr-wizard-sub">${t('ehr_onb_step1_sub')}</p><div class="form-group" style="margin:24px 0"><input type="text" id="ehrRfcInput" placeholder="${t('ehr_onb_step1_placeholder')}" maxlength="13" style="width:100%;padding:14px;border:1px solid rgba(25,68,69,0.12);border-radius:10px;font-size:15px;text-transform:uppercase;letter-spacing:1px;outline:none"></div><div id="ehrRfcResult" style="min-height:24px;margin-bottom:16px"></div><button class="btn-primary" id="ehrRfcBtn" disabled>${t('ehr_onb_step1_btn')}</button></div>`;
    } else if (step === 1) {
      const docRows = ['rfc','acta','id','address'].map(key => `<div class="onb-upload-row"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0"><span style="font-size:13px;font-weight:600;color:var(--t1)">${t('ehr_onb_step2_'+key)}</span><label class="onb-upload-btn" id="ehrUpload_${key}"><input type="file" accept=".pdf,image/*" style="display:none" data-doc="${key}">${t('onb_e_step4_upload')}</label></div></div>`).join('');
      stepContent = `<div class="ehr-wizard-card"><h2 class="ehr-wizard-h">${t('ehr_onb_step2_h')}</h2><p class="ehr-wizard-sub">${t('ehr_onb_step2_sub')}</p><div style="margin:24px 0">${docRows}</div><button class="btn-primary" id="ehrDocNext" disabled>${t('onb_next')}</button></div>`;
    } else if (step === 2) {
      const screeningStatus = emp.screeningPassed ? t('ehr_onb_step3_passed') : t('ehr_onb_step3_review');
      const statusClass = emp.screeningPassed ? 'badge-active' : 'badge-pending';
      stepContent = `<div class="ehr-wizard-card"><h2 class="ehr-wizard-h">${t('ehr_onb_step3_h')}</h2><p class="ehr-wizard-sub">${t('ehr_onb_step3_sub')}</p><div style="margin:24px 0;text-align:center"><div style="margin-bottom:16px"><span class="badge ${statusClass}" style="font-size:14px;padding:8px 20px">${screeningStatus}</span></div>${!emp.screeningPassed ? `<p style="color:var(--t3);font-size:13px">${t('ehr_onb_step3_waiting')}</p>` : `<button class="btn-primary" id="ehrScreenNext">${t('onb_next')}</button>`}</div></div>`;
    } else if (step === 3) {
      const payrollSystems = ['Nomipaq','Aspel NOI','CONTPAQi','Workday','ADP',t('onb_e_step3_payroll_other')];
      stepContent = `<div class="ehr-wizard-card"><h2 class="ehr-wizard-h">${t('ehr_onb_step4_h')}</h2><p class="ehr-wizard-sub">${t('ehr_onb_step4_sub')}</p><form id="ehrIntegrationForm" style="margin:24px 0"><div class="form-group" style="margin-bottom:16px"><label style="font-size:13px;font-weight:600;color:var(--t1);display:block;margin-bottom:6px">${t('ehr_onb_step4_method')}</label><div class="ehr-filter-group"><button type="button" class="ehr-filter-btn active" data-method="api">${t('ehr_onb_step4_api')}</button><button type="button" class="ehr-filter-btn" data-method="sftp">${t('ehr_onb_step4_sftp')}</button><button type="button" class="ehr-filter-btn" data-method="manual">${t('ehr_onb_step4_manual')}</button></div></div><div class="form-group" style="margin-bottom:16px"><label style="font-size:13px;font-weight:600;color:var(--t1);display:block;margin-bottom:6px">${t('ehr_onb_step4_payroll')}</label><select id="ehrPayrollSystem" style="width:100%;padding:12px;border:1px solid rgba(25,68,69,0.12);border-radius:8px;font-size:13px;outline:none">${payrollSystems.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div><div class="form-group" style="margin-bottom:24px"><label style="font-size:13px;font-weight:600;color:var(--t1);display:block;margin-bottom:6px">${t('ehr_onb_step4_frequency')}</label><div class="ehr-filter-group"><button type="button" class="ehr-filter-btn" data-freq="weekly">${t('ehr_onb_step4_weekly')}</button><button type="button" class="ehr-filter-btn active" data-freq="biweekly">${t('ehr_onb_step4_biweekly')}</button><button type="button" class="ehr-filter-btn" data-freq="monthly">${t('ehr_onb_step4_monthly')}</button></div></div><button type="submit" class="btn-primary" id="ehrSaveIntegration">${t('ehr_onb_step4_save')}</button></form></div>`;
    } else {
      stepContent = `<div class="ehr-wizard-card" style="text-align:center"><div class="onb-check-circle" style="background:rgba(36,122,110,0.1);margin:0 auto 20px"><svg viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div><h2 class="ehr-wizard-h" style="text-align:center">${t('ehr_onb_complete')}</h2><button class="btn-primary" style="margin-top:20px" onclick="navigate('/employer/dashboard')">${t('ehr_overview')}</button></div>`;
    }

    const container = document.querySelector('.dash-content');
    if (container) {
      container.innerHTML = (step < 4 ? progressBar : '') + stepContent;
      bindWizardStep();
    }
  }

  let selectedMethod = 'api', selectedFreq = 'biweekly';
  const uploadedDocs = {};

  function bindWizardStep() {
    // Step 0: RFC verification
    const rfcInput = document.getElementById('ehrRfcInput');
    const rfcBtn = document.getElementById('ehrRfcBtn');
    if (rfcInput && rfcBtn) {
      rfcInput.addEventListener('input', () => {
        rfcInput.value = rfcInput.value.toUpperCase();
        rfcBtn.disabled = rfcInput.value.length < 12;
      });
      rfcBtn.addEventListener('click', async () => {
        rfcBtn.disabled = true; rfcBtn.textContent = t('ehr_onb_step1_checking');
        const resultEl = document.getElementById('ehrRfcResult');
        try {
          await db.collection('employers').doc(uid).update({ rfc: rfcInput.value, onboardingStep: 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          if (resultEl) resultEl.innerHTML = `<span style="color:var(--success);font-size:13px;font-weight:600">RFC ${rfcInput.value} — ${t('ehr_onb_step3_passed')}</span>`;
          step = 1;
          setTimeout(render, 800);
        } catch (e) {
          if (resultEl) resultEl.innerHTML = `<span style="color:var(--danger);font-size:13px">${e.message}</span>`;
          rfcBtn.disabled = false; rfcBtn.textContent = t('ehr_onb_step1_btn');
        }
      });
    }

    // Step 1: Document uploads
    document.querySelectorAll('[data-doc]').forEach(input => {
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const key = input.dataset.doc;
        const label = input.closest('.onb-upload-btn');
        label.classList.add('uploading');
        label.textContent = t('onb_e_step4_uploading');
        try {
          const ref = storage.ref(`employers/${uid}/onboarding/${key}_${Date.now()}`);
          await ref.put(file);
          const url = await ref.getDownloadURL();
          uploadedDocs[key] = url;
          label.classList.remove('uploading');
          label.classList.add('done');
          label.textContent = t('onb_e_step4_done');
        } catch (e) {
          label.classList.remove('uploading');
          label.classList.add('error');
          label.textContent = t('onb_e_step4_error');
        }
        const docNext = document.getElementById('ehrDocNext');
        if (docNext) docNext.disabled = Object.keys(uploadedDocs).length < 2;
      });
    });
    document.getElementById('ehrDocNext')?.addEventListener('click', async () => {
      await db.collection('employers').doc(uid).update({ onboardingDocs: uploadedDocs, onboardingStep: 2, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      step = 2; render();
    });

    // Step 2: Screening next
    document.getElementById('ehrScreenNext')?.addEventListener('click', async () => {
      await db.collection('employers').doc(uid).update({ onboardingStep: 3, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      step = 3; render();
    });

    // Step 3: Integration setup
    document.querySelectorAll('[data-method]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.ehr-filter-group').querySelectorAll('.ehr-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMethod = btn.dataset.method;
      });
    });
    document.querySelectorAll('[data-freq]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.ehr-filter-group').querySelectorAll('.ehr-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedFreq = btn.dataset.freq;
      });
    });
    document.getElementById('ehrIntegrationForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('ehrSaveIntegration');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = t('ehr_onb_step4_saving'); }
      const payrollSystem = document.getElementById('ehrPayrollSystem')?.value;
      try {
        await db.collection('employers').doc(uid).update({
          integrationMethod: selectedMethod, payrollSystem, payFrequency: selectedFreq,
          onboardingStep: 4, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        step = 4; render();
        showToast(t('ehr_onb_complete'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('ehr_onb_step4_save'); }
      }
    });
  }

  app.innerHTML = shell('');
  ehrBindNav();
  render();
}

// ─── Credit Usage Analytics ─────────────────────────────
async function renderEhrAnalytics(app, uid, emp, shell) {
  app.innerHTML = shell('<div style="padding:40px;text-align:center"><span class="spinner" style="border-color:rgba(25,68,69,0.1);border-top-color:var(--brand)"></span></div>');
  ehrBindNav();

  const [loansSnap, empSnap] = await Promise.all([
    db.collection('loans').where('employerId', '==', uid).get(),
    db.collection('employers').doc(uid).collection('employees').get()
  ]);

  const loans = loansSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const totalEmployees = empSnap.size || 1;

  // Build monthly data for last 6 months
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.toISOString().slice(0,7), label: d.toLocaleDateString(currentLang === 'es' ? 'es-MX' : 'en-US', { month: 'short', year: '2-digit' }) });
  }

  const monthlyData = months.map(m => {
    const monthLoans = loans.filter(l => l.createdAt && new Date((l.createdAt.seconds||0)*1000).toISOString().slice(0,7) === m.key);
    const activeInMonth = monthLoans.filter(l => ['active','disbursed','paid','overdue'].includes(l.status));
    const uniqueBorrowers = new Set(activeInMonth.map(l => l.userId || l.employeeId)).size;
    const overdueInMonth = monthLoans.filter(l => l.status === 'overdue').length;
    const maturedInMonth = monthLoans.filter(l => ['paid','overdue'].includes(l.status)).length;
    return {
      ...m,
      volume: monthLoans.length,
      totalAmount: monthLoans.reduce((s,l) => s + (l.amount||0), 0),
      adoptionRate: Math.round((uniqueBorrowers / totalEmployees) * 100),
      defaultRate: maturedInMonth > 0 ? Math.round((overdueInMonth / maturedInMonth) * 100) : 0
    };
  });

  const maxVolume = Math.max(...monthlyData.map(m => m.volume), 1);
  const maxAdoption = Math.max(...monthlyData.map(m => m.adoptionRate), 1);

  // Sector benchmark (anonymized/static for now)
  const sectorAvg = { adoption: 12, defaultRate: 4 };
  const yourAdoption = monthlyData[monthlyData.length-1]?.adoptionRate || 0;
  const yourDefault = monthlyData[monthlyData.length-1]?.defaultRate || 0;

  const chartBar = (values, maxVal, color) => values.map((v, i) => {
    const pct = maxVal > 0 ? Math.round((v / maxVal) * 100) : 0;
    return `<div class="ehr-chart-col"><div class="ehr-chart-bar" style="height:${Math.max(pct, 4)}%;background:${color}"></div><div class="ehr-chart-label">${months[i].label}</div></div>`;
  }).join('');

  const content = `
    <div class="ehr-analytics-grid">
      <div class="card ehr-chart-card"><div class="card-title">${t('ehr_an_adoption')}</div><p style="font-size:12px;color:var(--t3);margin-bottom:16px">${t('ehr_an_over_time')}</p><div class="ehr-chart">${chartBar(monthlyData.map(m=>m.adoptionRate), maxAdoption, 'var(--brand)')}</div></div>
      <div class="card ehr-chart-card"><div class="card-title">${t('ehr_an_loan_volume')}</div><p style="font-size:12px;color:var(--t3);margin-bottom:16px">${t('ehr_an_by_month')}</p><div class="ehr-chart">${chartBar(monthlyData.map(m=>m.volume), maxVolume, 'var(--aqua)')}</div></div>
      <div class="card ehr-chart-card"><div class="card-title">${t('ehr_an_default_rate')}</div><p style="font-size:12px;color:var(--t3);margin-bottom:16px">${t('ehr_an_by_cohort')}</p><div class="ehr-chart">${chartBar(monthlyData.map(m=>m.defaultRate), 100, 'var(--danger)')}</div></div>
      <div class="card ehr-chart-card"><div class="card-title">${t('ehr_an_benchmark')}</div><p style="font-size:12px;color:var(--t3);margin-bottom:16px">${t('ehr_an_adoption')}</p>
        <div class="ehr-benchmark">
          <div class="ehr-bench-row"><span class="ehr-bench-label">${t('ehr_an_your_rate')}</span><div class="ehr-bench-bar-wrap"><div class="ehr-bench-bar" style="width:${Math.min(yourAdoption,100)}%;background:var(--brand)"></div></div><span class="ehr-bench-val">${yourAdoption}%</span></div>
          <div class="ehr-bench-row"><span class="ehr-bench-label">${t('ehr_an_sector_avg')}</span><div class="ehr-bench-bar-wrap"><div class="ehr-bench-bar" style="width:${Math.min(sectorAvg.adoption,100)}%;background:var(--t3)"></div></div><span class="ehr-bench-val">${sectorAvg.adoption}%</span></div>
        </div>
        <div style="margin-top:20px"><p style="font-size:12px;color:var(--t3);margin-bottom:8px">${t('ehr_an_default_rate')}</p>
          <div class="ehr-benchmark">
            <div class="ehr-bench-row"><span class="ehr-bench-label">${t('ehr_an_your_rate')}</span><div class="ehr-bench-bar-wrap"><div class="ehr-bench-bar" style="width:${Math.min(yourDefault*5,100)}%;background:${yourDefault > sectorAvg.defaultRate ? 'var(--danger)' : 'var(--success)'}"></div></div><span class="ehr-bench-val">${yourDefault}%</span></div>
            <div class="ehr-bench-row"><span class="ehr-bench-label">${t('ehr_an_sector_avg')}</span><div class="ehr-bench-bar-wrap"><div class="ehr-bench-bar" style="width:${Math.min(sectorAvg.defaultRate*5,100)}%;background:var(--t3)"></div></div><span class="ehr-bench-val">${sectorAvg.defaultRate}%</span></div>
          </div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:24px"><div class="card-title">${t('ehr_an_loan_volume')} — ${t('ehr_ded_month')}</div><div class="table-wrap"><table><thead><tr><th>${t('ehr_ded_month')}</th><th>${t('ehr_an_loan_volume')}</th><th>${t('ehr_th_amount')}</th><th>${t('ehr_an_adoption')}</th><th>${t('ehr_an_default_rate')}</th></tr></thead><tbody>${monthlyData.map(m => `<tr><td>${m.label}</td><td>${m.volume}</td><td>$${fmt(m.totalAmount)}</td><td>${m.adoptionRate}%</td><td>${m.defaultRate}%</td></tr>`).join('')}</tbody></table></div></div>`;

  app.innerHTML = shell(content);
  ehrBindNav();
}
window.approveLoan = async function(id, btn) {
  if (btn && btn.dataset.loading === 'true') return;
  if (btn) { btn.dataset.loading = 'true'; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    await db.collection('loans').doc(id).update({ status: 'approved', approvedAt: firebase.firestore.FieldValue.serverTimestamp() });
    showToast(t('toast_loan_approved'), 'success');
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.dataset.loading = 'false'; btn.textContent = t('dash_approve'); }
  }
};
window.rejectLoan = async function(id, btn) {
  if (btn && btn.dataset.loading === 'true') return;
  if (btn) { btn.dataset.loading = 'true'; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const l = (await db.collection('loans').doc(id).get()).data();
    await db.collection('loans').doc(id).update({ status: 'rejected', rejectedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await db.collection('employees').doc(l.employeeId).update({ availableCredit: firebase.firestore.FieldValue.increment(l.amount) });
    showToast(t('toast_loan_rejected'), 'error');
  } catch (e) {
    showToast(e.message, 'error');
    if (btn) { btn.dataset.loading = 'false'; btn.textContent = t('dash_reject'); }
  }
};

// ─── EMPLOYEE DASHBOARD ──────────────────────────────────
async function renderEmployeeDashboard(app) {
  app.innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  if (!auth.currentUser?.emailVerified) {
    app.innerHTML = '<div style="max-width:600px;margin:80px auto;text-align:center;padding:40px"><h2>Verifica tu correo electrónico</h2><p style="margin:16px 0;color:var(--t2)">Te enviamos un enlace de verificación. Revisa tu bandeja de entrada y vuelve a iniciar sesión.</p><button class="btn-primary" onclick="auth.signOut().then(()=>navigate(\'/login\'))">Volver al inicio</button></div>';
    return;
  }
  const uid = auth.currentUser.uid;
  const empDoc = await db.collection('employees').doc(uid).get();
  if (!empDoc.exists) { navigate('/employer/dashboard'); return; }
  const emp = empDoc.data();
  const utilized = emp.creditLimit - emp.availableCredit;
  const utilPct = Math.round((utilized / emp.creditLimit) * 100);
  app.innerHTML = `<div class="dash"><aside class="dash-side"><div class="nav-logo">${vidaLogo()}</div><nav class="dash-nav"><a href="#" class="active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>${t('dash_dashboard')}</a><a href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>${t('dash_my_loans')}</a></nav><button class="dash-logout" onclick="auth.signOut().then(()=>navigate('/'))"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>${t('dash_signout')}</button></aside><div class="dash-main"><div class="dash-header"><h1>${t('dash_welcome')}, ${emp.name}</h1><div class="dash-user"><span>${emp.employerName}</span><a href="#" onclick="event.preventDefault();toggleLang()" style="font-size:12px;font-weight:600;color:var(--brand);margin-left:12px">${t('lang_toggle')}</a><div class="dash-avatar">${emp.name?.charAt(0)||'E'}</div></div></div><div class="dash-content"><div class="stat-grid"><div class="stat-card"><div class="stat-label">${t('dash_available_credit')}</div><div class="stat-value">$${fmt(emp.availableCredit)}</div><div class="stat-change">MXN</div></div><div class="stat-card"><div class="stat-label">${t('dash_credit_limit')}</div><div class="stat-value">$${fmt(emp.creditLimit)}</div></div><div class="stat-card"><div class="stat-label">${t('dash_utilization')}</div><div class="stat-value">${utilPct}%</div></div><div class="stat-card"><div class="stat-label">${t('dash_quick_action')}</div><button class="btn-primary" style="margin-top:8px" onclick="openLoanModal()">${t('dash_request_funds')}</button></div></div><div class="card"><div class="card-title">${t('dash_your_loans')}</div><div class="table-wrap" id="empLoansTable"><div style="padding:40px;text-align:center"><span class="spinner" style="border-color:rgba(25,68,69,0.1);border-top-color:var(--brand)"></span></div></div></div></div></div></div>`;
  function renderEmployeeLoansTable(loans) {
    const el = document.getElementById('empLoansTable');
    if (!el) return;
    el.innerHTML = loans.length ? `<table><thead><tr><th>${t('dash_th_amount')}</th><th>${t('dash_th_term')}</th><th>${t('dash_th_repayment')}</th><th>${t('dash_th_status')}</th><th>${t('dash_th_docs')}</th><th>${t('dash_th_date')}</th><th>${t('dash_th_action')}</th></tr></thead><tbody>${loans.map(l=>`<tr><td>$${fmt(l.amount)}</td><td>${l.termDays||30} ${t('dash_days')}</td><td>$${fmt(l.repaymentAmount||l.total||0)}</td><td><span class="badge badge-${l.status}">${t('status_'+l.status)}</span></td><td>${renderDocLinks(l)}</td><td>${l.createdAt?new Date(l.createdAt.seconds*1000).toLocaleDateString():'—'}</td><td>${['active','overdue'].includes(l.status)?`<button class="btn-sm btn-approve pay-now-btn" data-loan-id="${l.id}">${t('dash_pay_now')}</button>`:'—'}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><p>${t('dash_no_loans_employee')}</p></div>`;
    el.querySelectorAll('.pay-now-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const loanId = btn.dataset.loanId;
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
        try { const r = await firebase.functions().httpsCallable('generatePaymentLink')({ loanId }); window.open(r.data.paymentUrl, '_blank'); }
        catch (_) { showToast(t('dash_pay_error'), 'error'); }
        finally { btn.disabled = false; btn.textContent = t('dash_pay_now'); }
      });
    });
  }
  if (window._unsubEmp) window._unsubEmp();
  window._unsubEmp = db.collection('loans').where('employeeId','==',uid).orderBy('createdAt','desc')
    .onSnapshot(snap => { renderEmployeeLoansTable(snap.docs.map(d=>({id:d.id,...d.data()}))); });
<div class="modal-overlay" id="loanModal"><div class="modal" style="position:relative"><div class="modal-close" onclick="closeLoanModal()">✕</div><h3>${t('modal_request')}</h3><p class="modal-sub">${t('modal_available')}: $${fmt(emp.availableCredit)} MXN</p><form id="loanForm"><div class="form-group"><label>${t('modal_amount')}</label><input type="number" id="loanAmount" min="500" max="${emp.availableCredit}" step="100" value="1000" required></div><div class="form-group" style="display:flex;justify-content:space-between;align-items:center;padding:12px 0"><span style="font-size:13px;color:var(--t3)">${t('modal_term')}</span><span style="font-size:14px;font-weight:700;color:var(--t1)">${t('modal_term_30')} · ${t('modal_rate')}</span></div><div style="border-top:1px solid rgba(25,68,69,0.06);border-bottom:1px solid rgba(25,68,69,0.06);padding:20px 0;margin-bottom:16px"><div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:13px;color:var(--t3)">${t('modal_loan_amount')}</span><span style="font-size:13px;font-weight:700;color:var(--t1)" id="modalAmount">$1,000</span></div><div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:13px;color:var(--t3)">${t('modal_fee')}</span><span style="font-size:13px;font-weight:700;color:var(--t1)" id="modalFee">$300</span></div><div style="height:1px;background:rgba(25,68,69,0.06);margin:4px 0"></div><div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-family:var(--df);font-size:15px;color:var(--t1)">${t('modal_total')}</span><span style="font-family:var(--df);font-size:18px;color:var(--t1)" id="modalTotal">$1,300</span></div><div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:13px;color:var(--t3)">${t('modal_due_date')}</span><span style="font-size:13px;font-weight:700;color:var(--t1)" id="modalDueDate"></span></div><div style="display:flex;justify-content:space-between;padding:8px 0"><span style="font-size:13px;color:var(--t3)">CAT (Costo Anual Total)</span><span class="cat-highlight" id="catDisplay"></span></div><p class="cat-note">El CAT es una medida estandarizada del costo. <a href="https://www.condusef.gob.mx" target="_blank" rel="noopener">CONDUSEF</a></p></div><label style="display:flex;align-items:center;gap:8px;margin-bottom:20px;cursor:pointer;font-size:13px;color:var(--t2)"><input type="checkbox" id="termsCheck"><span>${t('modal_accept_terms')}</span></label><div class="auth-error" id="loanError" style="margin-bottom:12px"></div><button type="submit" class="btn-primary" id="loanSubmitBtn" disabled>${t('modal_confirm')}</button></form></div></div>`;
  const amountIn=document.getElementById('loanAmount');
  const termsCheck=document.getElementById('termsCheck');
  const loanSubmitBtn=document.getElementById('loanSubmitBtn');
  const loanError=document.getElementById('loanError');
  const dueDate=new Date(Date.now()+30*24*60*60*1000);
  document.getElementById('modalDueDate').textContent=dueDate.toLocaleDateString();
  termsCheck.addEventListener('change',()=>{loanSubmitBtn.disabled=!termsCheck.checked;});
  function updateModal(){const a=parseInt(amountIn.value)||0,fee=Math.round(a*0.30);document.getElementById('modalAmount').textContent='$'+fmt(a);document.getElementById('modalFee').textContent='$'+fmt(fee);document.getElementById('modalTotal').textContent='$'+fmt(a+fee);const cat=a>0?((Math.pow(1+fee/a,365/30)-1)*100).toFixed(0):'0';document.getElementById('catDisplay').textContent=cat+'% anual';}
  amountIn.addEventListener('input',updateModal);
  updateModal();
  document.getElementById('loanForm').addEventListener('submit',async(e)=>{e.preventDefault();loanError.classList.remove('show');loanSubmitBtn.disabled=true;loanSubmitBtn.innerHTML='<span class="spinner"></span>'+t('modal_submitting');try{const amount=parseInt(amountIn.value);if(amount>emp.availableCredit)throw new Error(t('modal_exceed'));if(amount<500)throw new Error(t('modal_minimum'));await firebase.functions().httpsCallable('requestLoan')({amount,term:30});closeLoanModal();showToast(t('toast_loan_submitted'),'success');}catch(err){const msg=err.message||err.toString();loanError.textContent=msg;loanError.classList.add('show');loanSubmitBtn.disabled=false;loanSubmitBtn.textContent=t('modal_confirm');}});
}
window.openLoanModal = function() { document.getElementById('loanModal')?.classList.add('show'); };
window.closeLoanModal = function() { document.getElementById('loanModal')?.classList.remove('show'); };

// ─── ADMIN PORTAL ────────────────────────────────────────
function renderAdminPortal(app, activeTab) {
  if (window._adminUnsubs) { window._adminUnsubs.forEach(u => u()); }
  window._adminUnsubs = [];

  const navItems = [
    { key: 'employers', label: 'Empleadores', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12h6M12 9v6"/></svg>', badge: 'badge-employers' },
    { key: 'loans', label: 'Préstamos', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>', badge: 'badge-loans', badgeClass: 'red' },
    { key: 'finance', label: 'Finanzas', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>', badge: '' },
    { key: 'audit', label: 'Auditoría', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>', badge: '' },
  ];

  app.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar"><div class="admin-logo"><span>VIDA ADMIN</span></div><nav>${navItems.map(n => `<div class="admin-nav-item${n.key===activeTab?' active':''}" data-tab="${n.key}">${n.icon}<span style="flex:1;margin-left:8px">${n.label}</span>${n.badge?`<span class="admin-badge${n.badgeClass?' '+n.badgeClass:''}" id="${n.badge}"></span>`:''}</div>`).join('')}</nav><div style="flex:1"></div><button class="admin-signout" onclick="auth.signOut().then(()=>navigate('/'))"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>Cerrar sesión</button></aside><div class="admin-main"><div class="health-strip" id="adminHealth"></div><div id="adminContent"></div></div></div>`;

  app.querySelectorAll('.admin-nav-item').forEach(el => {
    el.addEventListener('click', () => navigate('/admin/' + el.dataset.tab));
  });

  // Live badge counts
  window._adminUnsubs.push(
    db.collection('employers').where('status','==','pending_verification')
      .onSnapshot(s => { const el = document.getElementById('badge-employers'); if (el) el.textContent = s.size || ''; }),
    db.collection('loans').where('status','==','overdue')
      .onSnapshot(s => { const el = document.getElementById('badge-loans'); if (el) el.textContent = s.size || ''; }),
    db.collection('system_health').doc('current')
      .onSnapshot(doc => {
        const el = document.getElementById('adminHealth');
        if (!el || !doc.exists) return;
        const d = doc.data();
        const pills = Object.entries(d.services || {}).map(([k, v]) =>
          `<span class="health-pill ${v === 'ok' ? 'ok' : v === 'degraded' ? 'warn' : 'down'}">${k}: ${v}</span>`
        ).join('');
        el.innerHTML = pills || '';
      })
  );

  const content = document.getElementById('adminContent');
  if (activeTab === 'employers') renderEmployersTab(content);
  else if (activeTab === 'loans') renderLoansTab(content);
  else if (activeTab === 'finance') renderFinanceTab(content);
  else if (activeTab === 'audit') renderAuditTab(content);
}

// ─── ADMIN: Employers Tab ────────────────────────────────
function renderEmployersTab(container) {
  const subTabs = ['pending_verification', 'active', 'rejected'];
  const subLabels = { pending_verification: 'Por verificar', active: 'Activos', rejected: 'Rechazados' };
  let activeSub = 'pending_verification';

  function render(sub) {
    activeSub = sub;
    const tabBar = `<div class="admin-tab-bar">${subTabs.map(s => `<div class="admin-tab${s===sub?' active':''}" data-sub="${s}">${subLabels[s]}</div>`).join('')}</div>`;
    container.innerHTML = tabBar + '<div id="empList"><div style="padding:40px;text-align:center"><span class="spinner"></span></div></div>';
    container.querySelectorAll('.admin-tab').forEach(el => {
      el.addEventListener('click', () => render(el.dataset.sub));
    });

    db.collection('employers').where('status', '==', sub).orderBy('createdAt', 'desc').get().then(snap => {
      const list = document.getElementById('empList');
      if (!list) return;
      if (snap.empty) { list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--t3)">Sin resultados</div>'; return; }
      list.innerHTML = snap.docs.map(d => {
        const e = d.data();
        const mlScore = e.mlRiskScore != null ? e.mlRiskScore : null;
        const tier = mlScore != null ? (mlScore >= 70 ? 'tier-1' : mlScore >= 40 ? 'tier-2' : 'tier-3') : null;
        const redFlags = (e.red_flags || []).map(f => `<span class="flag-pill red">${f}</span>`).join('');
        const greenFlags = (e.green_flags || []).map(f => `<span class="flag-pill green">${f}</span>`).join('');
        const docs = [
          e.docRFC ? `<a href="${e.docRFC}" target="_blank" class="doc-link">RFC</a>` : '',
          e.docId ? `<a href="${e.docId}" target="_blank" class="doc-link">ID</a>` : '',
          e.docAddress ? `<a href="${e.docAddress}" target="_blank" class="doc-link">Domicilio</a>` : ''
        ].filter(Boolean).join(' ');
        const manualBanner = e.requiresManualReview ? `<div style="background:#fdf7e8;color:#7a5a10;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;margin-bottom:12px">⚠ Requiere revisión manual</div>` : '';
        const actions = sub === 'pending_verification'
          ? `<div style="display:flex;gap:8px;margin-top:16px"><button class="btn-sm btn-approve" data-action="approve" data-id="${d.id}">Aprobar</button><button class="btn-sm btn-reject" data-action="reject" data-id="${d.id}">Rechazar</button></div>`
          : sub === 'rejected' ? `<div style="margin-top:8px;font-size:12px;color:var(--t3)">Motivo: ${e.rejectionReason || '—'}</div>` : '';
        return `<div class="employer-card">${manualBanner}<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px"><div><div style="font-size:16px;font-weight:700;color:var(--t1)">${e.companyName || '—'}</div><div style="font-size:13px;color:var(--t3);margin-top:2px">${e.name} · ${e.email} · Código: ${e.employerCode || '—'}</div><div style="margin-top:8px">${docs}</div></div><div style="text-align:right">${tier ? `<span class="ml-badge ${tier}">ML: ${mlScore}</span>` : ''}</div></div>${redFlags || greenFlags ? `<div style="margin-top:10px">${redFlags}${greenFlags}</div>` : ''}${actions}</div>`;
      }).join('');

      list.querySelectorAll('[data-action="approve"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.loading === 'true') return;
          btn.dataset.loading = 'true'; btn.innerHTML = '<span class="spinner"></span>';
          try {
            const fn = firebase.functions().httpsCallable('approveEmployer');
            await fn({ employerUid: btn.dataset.id });
            showToast('Empleador aprobado', 'success');
            render(activeSub);
          } catch (err) { showToast(err.message, 'error'); btn.dataset.loading = 'false'; btn.textContent = 'Aprobar'; }
        });
      });
      list.querySelectorAll('[data-action="reject"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('.employer-card');
          if (card.querySelector('.reject-form')) return;
          const form = document.createElement('div');
          form.className = 'reject-form';
          form.style.cssText = 'margin-top:12px';
          form.innerHTML = `<textarea placeholder="Motivo del rechazo..." style="width:100%;padding:10px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;min-height:60px;resize:vertical;margin-bottom:8px"></textarea><button class="btn-sm btn-reject" style="font-size:12px">Confirmar rechazo</button>`;
          card.appendChild(form);
          form.querySelector('button').addEventListener('click', async () => {
            const reason = form.querySelector('textarea').value.trim();
            if (!reason) { showToast('Ingresa un motivo', 'error'); return; }
            try {
              await db.collection('employers').doc(btn.dataset.id).update({
                status: 'rejected', rejectionReason: reason,
                rejectedAt: firebase.firestore.FieldValue.serverTimestamp()
              });
              showToast('Empleador rechazado', 'error');
              render(activeSub);
            } catch (err) { showToast(err.message, 'error'); }
          });
        });
      });
    });
  }
  render(activeSub);
}

// ─── ADMIN: Loans Tab ────────────────────────────────────
function renderLoansTab(container) {
  const subTabs = ['to_disburse', 'active', 'overdue', 'all'];
  const subLabels = { to_disburse: 'Por desembolsar', active: 'Activos', overdue: 'Vencidos', all: 'Todos' };
  let activeSub = 'to_disburse';

  function render(sub) {
    activeSub = sub;
    const tabBar = `<div class="admin-tab-bar">${subTabs.map(s => `<div class="admin-tab${s===sub?' active':''}" data-sub="${s}">${subLabels[s]}</div>`).join('')}</div>`;
    container.innerHTML = tabBar + '<div id="loanList"><div style="padding:40px;text-align:center"><span class="spinner"></span></div></div>';
    container.querySelectorAll('.admin-tab').forEach(el => {
      el.addEventListener('click', () => render(el.dataset.sub));
    });

    let query;
    if (sub === 'to_disburse') query = db.collection('loans').where('status', 'in', ['approved', 'disbursement_queued']).orderBy('createdAt', 'desc');
    else if (sub === 'active') query = db.collection('loans').where('status', '==', 'active').orderBy('createdAt', 'desc');
    else if (sub === 'overdue') query = db.collection('loans').where('status', '==', 'overdue').orderBy('createdAt', 'desc');
    else query = db.collection('loans').orderBy('createdAt', 'desc').limit(200);

    query.get().then(snap => {
      const list = document.getElementById('loanList');
      if (!list) return;
      if (snap.empty) { list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--t3)">Sin préstamos</div>'; return; }
      const loans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const dueDate = (l) => l.dueDate ? new Date(l.dueDate.seconds * 1000).toLocaleDateString() : '—';
      list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Empleado</th><th>Empresa</th><th>Monto</th><th>Total</th><th>Vence</th><th>Estado</th><th>ML Score</th><th>Acciones</th></tr></thead><tbody>${loans.map(l => {
        const mlScore = l.mlCreditScore != null ? l.mlCreditScore : null;
        const tier = mlScore != null ? (mlScore >= 70 ? 'tier-1' : mlScore >= 40 ? 'tier-2' : 'tier-3') : null;
        let actions = '—';
        if (sub === 'to_disburse') actions = `<button class="btn-sm btn-approve" data-action="disburse" data-id="${l.id}">Confirmar desembolso</button>`;
        else if (sub === 'overdue' && l.employeePhone) actions = `<a href="https://wa.me/52${l.employeePhone}" target="_blank" class="btn-sm btn-approve" style="text-decoration:none;display:inline-block">Contactar</a>`;
        return `<tr><td>${l.employeeName || '—'}</td><td>${l.employerName || l.employerId || '—'}</td><td>$${fmt(l.amount)}</td><td>$${fmt(l.repaymentAmount)}</td><td>${dueDate(l)}</td><td><span class="badge badge-${l.status}">${l.status}</span></td><td>${tier ? `<span class="ml-badge ${tier}">${mlScore}</span>` : '—'}</td><td>${actions}</td></tr>`;
      }).join('')}</tbody></table></div>`;

      list.querySelectorAll('[data-action="disburse"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.loading === 'true') return;
          btn.dataset.loading = 'true'; btn.innerHTML = '<span class="spinner"></span>';
          try {
            const fn = firebase.functions().httpsCallable('markLoanDisbursed');
            await fn({ loanId: btn.dataset.id, disbursementRef: 'MANUAL' });
            showToast('Desembolso confirmado', 'success');
            render(activeSub);
          } catch (err) { showToast(err.message, 'error'); btn.dataset.loading = 'false'; btn.textContent = 'Confirmar desembolso'; }
        });
      });
    });
  }
  render(activeSub);
}

// ─── ADMIN: Finance Tab ──────────────────────────────────
function renderFinanceTab(container) {
  container.innerHTML = '<div style="padding:40px;text-align:center"><span class="spinner"></span></div>';

  Promise.all([
    db.collection('loans').get(),
    db.collection('repayments').get(),
    db.collection('portfolio_snapshots').orderBy('snapshotDate', 'desc').limit(12).get(),
  ]).then(([loansSnap, repSnap, snapshots]) => {
    const loans = loansSnap.docs.map(d => d.data());
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalDisbursed = loans.reduce((s, l) => s + (l.amount || 0), 0);
    const activePortfolio = loans.filter(l => l.status === 'active').reduce((s, l) => s + (l.repaymentAmount || 0), 0);
    const overduePortfolio = loans.filter(l => l.status === 'overdue').reduce((s, l) => s + (l.repaymentAmount || 0), 0);
    const totalCollected = repSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const denom = loans.filter(l => ['active', 'overdue', 'paid'].includes(l.status)).length;
    const overdueRate = denom > 0 ? ((loans.filter(l => l.status === 'overdue').length / denom) * 100).toFixed(1) : '0.0';
    const loansThisMonth = loans.filter(l => l.createdAt && new Date(l.createdAt.seconds * 1000) >= monthStart).length;

    const kpis = [
      { label: 'Total Desembolsado', val: '$' + fmt(totalDisbursed) },
      { label: 'Cartera Activa', val: '$' + fmt(activePortfolio) },
      { label: 'Cartera Vencida', val: '$' + fmt(overduePortfolio), warn: overduePortfolio > 0 },
      { label: 'Total Cobrado', val: '$' + fmt(totalCollected) },
      { label: 'Tasa de Morosidad', val: overdueRate + '%', warn: parseFloat(overdueRate) > 5 },
      { label: 'Préstamos del Mes', val: loansThisMonth },
    ];

    let html = `<div class="kpi-grid">${kpis.map(k => `<div class="kpi-card${k.warn?' warn':''}"><div class="kpi-val">${k.val}</div><div class="kpi-label">${k.label}</div></div>`).join('')}</div>`;

    // Portfolio snapshots table
    if (!snapshots.empty) {
      html += `<div style="background:#fff;border-radius:12px;padding:20px;border:1px solid rgba(25,68,69,.06);margin-bottom:20px"><div style="font-size:14px;font-weight:700;color:var(--t1);margin-bottom:12px">Historial de Cartera</div><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Activa</th><th>Vencida</th><th>Cobrada</th><th>Préstamos</th></tr></thead><tbody>${snapshots.docs.map(d => {
        const s = d.data();
        return `<tr><td>${s.snapshotDate ? new Date(s.snapshotDate.seconds * 1000).toLocaleDateString() : '—'}</td><td>$${fmt(s.activePortfolio || 0)}</td><td>$${fmt(s.overduePortfolio || 0)}</td><td>$${fmt(s.collectedAmount || 0)}</td><td>${s.totalLoans || 0}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
    }

    // Queue depth
    html += '<div id="queueDepth" style="background:#fff;border-radius:12px;padding:20px;border:1px solid rgba(25,68,69,.06)"><div style="font-size:14px;font-weight:700;color:var(--t1);margin-bottom:12px">Colas de Procesamiento</div><div style="text-align:center;padding:20px"><span class="spinner"></span></div></div>';
    container.innerHTML = html;

    window._adminUnsubs.push(
      db.collection('system_health').doc('queues').onSnapshot(doc => {
        const el = document.getElementById('queueDepth');
        if (!el || !doc.exists) return;
        const q = doc.data();
        const queues = Object.entries(q).filter(([k]) => k !== 'updatedAt');
        if (!queues.length) { el.querySelector('div:last-child').innerHTML = '<div style="text-align:center;color:var(--t3);padding:12px">Sin datos de colas</div>'; return; }
        el.querySelector('div:last-child').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Cola</th><th>En espera</th><th>Activo</th><th>Fallido</th><th>Completado</th></tr></thead><tbody>${queues.map(([name, v]) => {
          const failed = v.failed || 0;
          return `<tr><td style="font-weight:600">${name}</td><td>${v.waiting || 0}</td><td>${v.active || 0}</td><td style="${failed > 0 ? 'color:#c0392b;font-weight:700' : ''}">${failed}</td><td>${v.completed || 0}</td></tr>`;
        }).join('')}</tbody></table></div>`;
      })
    );
  }).catch(err => {
    container.innerHTML = `<div style="padding:40px;color:#c0392b">${err.message}</div>`;
  });
}

// ─── ADMIN: Audit Tab ────────────────────────────────────
function renderAuditTab(container) {
  let allLogs = [];
  let filters = { search: '', action: '', dateFrom: '', dateTo: '' };

  container.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;align-items:flex-end"><div style="flex:1;min-width:180px"><label style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Buscar</label><input type="text" id="auditSearch" placeholder="UID, email, ID..." style="width:100%;padding:8px 12px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;outline:none"></div><div><label style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Acción</label><select id="auditAction" style="padding:8px 12px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;outline:none"><option value="">Todas</option></select></div><div><label style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Desde</label><input type="date" id="auditFrom" style="padding:8px 12px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;outline:none"></div><div><label style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px">Hasta</label><input type="date" id="auditTo" style="padding:8px 12px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;outline:none"></div><button class="btn-sm btn-approve" id="auditExport" style="height:36px">Export CSV</button></div><div class="table-wrap" id="auditTable"><div style="padding:40px;text-align:center"><span class="spinner"></span></div></div>`;

  db.collection('audit_log').orderBy('timestamp', 'desc').limit(200).get().then(snap => {
    allLogs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const actions = [...new Set(allLogs.map(l => l.action).filter(Boolean))];
    const sel = document.getElementById('auditAction');
    if (sel) actions.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; sel.appendChild(o); });
    renderAuditTable();
  });

  function filterLogs() {
    return allLogs.filter(l => {
      if (filters.search) {
        const s = filters.search.toLowerCase();
        const haystack = [l.actorUid, l.actorEmail, l.targetId, l.action, l.details].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(s)) return false;
      }
      if (filters.action && l.action !== filters.action) return false;
      if (filters.dateFrom) {
        const ts = l.timestamp ? new Date(l.timestamp.seconds * 1000) : null;
        if (!ts || ts < new Date(filters.dateFrom)) return false;
      }
      if (filters.dateTo) {
        const ts = l.timestamp ? new Date(l.timestamp.seconds * 1000) : null;
        const end = new Date(filters.dateTo); end.setDate(end.getDate() + 1);
        if (!ts || ts >= end) return false;
      }
      return true;
    });
  }

  function renderAuditTable() {
    const filtered = filterLogs();
    const el = document.getElementById('auditTable');
    if (!el) return;
    if (!filtered.length) { el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--t3)">Sin registros</div>'; return; }
    el.innerHTML = `<table><thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Target</th><th>Detalles</th></tr></thead><tbody>${filtered.map(l => {
      const ts = l.timestamp ? new Date(l.timestamp.seconds * 1000).toLocaleString() : '—';
      return `<tr><td style="white-space:nowrap;font-size:12px">${ts}</td><td style="font-size:12px">${l.actorEmail || l.actorUid || '—'}</td><td><span class="badge badge-active" style="font-size:10px">${l.action || '—'}</span></td><td style="font-size:12px;max-width:120px;overflow:hidden;text-overflow:ellipsis">${l.targetId || '—'}</td><td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${l.details || '—'}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  document.getElementById('auditSearch')?.addEventListener('input', (e) => { filters.search = e.target.value; renderAuditTable(); });
  document.getElementById('auditAction')?.addEventListener('change', (e) => { filters.action = e.target.value; renderAuditTable(); });
  document.getElementById('auditFrom')?.addEventListener('change', (e) => { filters.dateFrom = e.target.value; renderAuditTable(); });
  document.getElementById('auditTo')?.addEventListener('change', (e) => { filters.dateTo = e.target.value; renderAuditTable(); });

  document.getElementById('auditExport')?.addEventListener('click', () => {
    const filtered = filterLogs();
    const header = 'Fecha,Actor,Email,Acción,Target,Detalles';
    const rows = filtered.map(l => {
      const ts = l.timestamp ? new Date(l.timestamp.seconds * 1000).toISOString() : '';
      return [ts, l.actorUid || '', l.actorEmail || '', l.action || '', l.targetId || '', '"' + (l.details || '').replace(/"/g, '""') + '"'].join(',');
    });
    const csv = header + '\n' + rows.join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'audit_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
  });
}

// ─── OPS PORTAL ──────────────────────────────────────────

function renderOpsPortal(app, activeTab) {
  if (window._opsUnsubs) { window._opsUnsubs.forEach(u => u()); }
  window._opsUnsubs = [];

  const navItems = [
    { key: 'review-queue', label: t('ops_nav_review'), icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>', badge: 'ops-badge-review' },
    { key: 'portfolio', label: t('ops_nav_portfolio'), icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>', badge: '' },
    { key: 'employers', label: t('ops_nav_employers'), icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12h6M12 9v6"/></svg>', badge: '' },
    { key: 'alerts', label: t('ops_nav_alerts'), icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', badge: 'ops-badge-alerts' },
  ];

  app.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar"><div class="admin-logo"><span>${t('ops_title')}</span></div><nav>${navItems.map(n => `<div class="admin-nav-item${n.key===activeTab?' active':''}" data-tab="${n.key}">${n.icon}<span style="flex:1;margin-left:8px">${n.label}</span>${n.badge?`<span class="admin-badge" id="${n.badge}"></span>`:''}</div>`).join('')}</nav><div style="flex:1"></div><button class="admin-signout" onclick="auth.signOut().then(()=>navigate('/'))"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>${t('ops_signout')}</button></aside><div class="admin-main"><div id="opsContent"></div></div></div>`;

  app.querySelectorAll('.admin-nav-item').forEach(el => {
    el.addEventListener('click', () => navigate('/ops/' + el.dataset.tab));
  });

  // Live badge for pending reviews
  window._opsUnsubs.push(
    db.collection('review_queue').where('status','==','pending_review')
      .onSnapshot(s => { const el = document.getElementById('ops-badge-review'); if (el) el.textContent = s.size || ''; })
  );

  const content = document.getElementById('opsContent');
  if (activeTab === 'review-queue') renderOpsReviewQueue(content);
  else if (activeTab === 'portfolio') renderOpsPortfolio(content);
  else if (activeTab === 'employers') renderOpsEmployers(content);
  else if (activeTab === 'alerts') renderOpsAlerts(content);
}

// ─── OPS: Review Queue ───────────────────────────────────
function renderOpsReviewQueue(container) {
  let allReviews = [];
  let sortBy = 'sla';
  let expandedId = null;

  function formatSla(queuedAt) {
    if (!queuedAt) return { text: '—', cls: '' };
    const ms = queuedAt.seconds ? queuedAt.seconds * 1000 : queuedAt;
    const deadline = ms + 24 * 60 * 60 * 1000;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { text: t('ops_rq_sla_expired'), cls: 'sla-red' };
    const hrs = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    const cls = hrs >= 12 ? 'sla-green' : hrs >= 4 ? 'sla-amber' : 'sla-red';
    return { text: `${hrs}h ${mins}m`, cls };
  }

  function riskLabel(level) {
    if (level === 'high') return `<span class="risk-pill risk-high">${t('ops_rq_risk_high')}</span>`;
    if (level === 'medium') return `<span class="risk-pill risk-medium">${t('ops_rq_risk_medium')}</span>`;
    return `<span class="risk-pill risk-low">${t('ops_rq_risk_low')}</span>`;
  }

  function sortReviews(reviews) {
    return [...reviews].sort((a, b) => {
      if (sortBy === 'risk') {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.risk_level] || 2) - (order[b.risk_level] || 2);
      }
      if (sortBy === 'confidence') return (a.confidence || 0) - (b.confidence || 0);
      // Default: SLA urgency (oldest first)
      const aMs = a.queuedAt?.seconds ? a.queuedAt.seconds : 0;
      const bMs = b.queuedAt?.seconds ? b.queuedAt.seconds : 0;
      return aMs - bMs;
    });
  }

  function render() {
    const sorted = sortReviews(allReviews.filter(r => r.status === 'pending_review'));
    const sortBtns = ['sla', 'risk', 'confidence'].map(s =>
      `<button class="btn-sm ops-sort-btn${sortBy===s?' active':''}" data-sort="${s}">${t('ops_rq_sort_' + s)}</button>`
    ).join('');

    container.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px"><h2 style="font-size:18px;font-weight:700;color:var(--t1);margin:0">${t('ops_rq_title')}</h2><div style="display:flex;gap:8px">${sortBtns}</div></div>` +
      (sorted.length === 0
        ? `<div style="padding:40px;text-align:center;color:var(--t3)">${t('ops_rq_empty')}</div>`
        : `<div class="table-wrap"><table><thead><tr><th>${t('ops_rq_col_applicant')}</th><th>${t('ops_rq_col_amount')}</th><th>${t('ops_rq_col_risk')}</th><th>${t('ops_rq_col_confidence')}</th><th>${t('ops_rq_col_sla')}</th><th>${t('ops_rq_col_actions')}</th></tr></thead><tbody>${sorted.map(r => {
          const sla = formatSla(r.queuedAt);
          const expanded = expandedId === r.id;
          return `<tr class="ops-review-row${expanded?' expanded':''}" data-id="${r.id}" style="cursor:pointer"><td style="font-weight:600">${r.applicantName || r.employeeName || '—'}</td><td>$${fmt(r.amount || 0)}</td><td>${riskLabel(r.risk_level)}</td><td>${r.confidence != null ? (r.confidence * 100).toFixed(0) + '%' : '—'}</td><td><span class="sla-timer ${sla.cls}">${sla.text}</span></td><td><div style="display:flex;gap:6px"><button class="btn-sm btn-approve ops-action" data-action="approved" data-id="${r.id}">${t('ops_rq_btn_approve')}</button><button class="btn-sm btn-reject ops-action" data-action="rejected" data-id="${r.id}">${t('ops_rq_btn_reject')}</button><button class="btn-sm ops-action" data-action="request_info" data-id="${r.id}" style="background:var(--aqua);color:var(--brand)">${t('ops_rq_btn_info')}</button></div></td></tr>` +
          (expanded ? `<tr class="ops-detail-row"><td colspan="6"><div class="ops-review-detail">` +
            `<div class="ops-detail-section"><h4>${t('ops_rq_detail_narrative')}</h4><p>${r.llm_narrative || '—'}</p></div>` +
            `<div class="ops-detail-section"><h4>${t('ops_rq_detail_signals')}</h4><div class="ops-signals">${(r.signals || []).map(s => `<div class="ops-signal"><span class="ops-signal-stage">S${s.stage}</span><span>${s.label}: <strong>${s.value}</strong></span></div>`).join('') || '—'}</div></div>` +
            `<div class="ops-detail-section"><h4>${t('ops_rq_detail_shap')}</h4><div class="ops-shap">${(r.shap_features || []).map(f => `<div class="ops-shap-bar"><span class="ops-shap-label">${f.feature}</span><div class="ops-shap-track"><div class="ops-shap-fill${f.impact>0?' positive':' negative'}" style="width:${Math.min(Math.abs(f.impact)*100,100)}%"></div></div><span class="ops-shap-val">${f.impact > 0 ? '+' : ''}${f.impact.toFixed(3)}</span></div>`).join('') || '—'}</div></div>` +
          `</div></td></tr>` : '');
        }).join('')}</tbody></table></div>`);

    // Sort buttons
    container.querySelectorAll('.ops-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => { sortBy = btn.dataset.sort; render(); });
    });

    // Row expand
    container.querySelectorAll('.ops-review-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.ops-action')) return;
        expandedId = expandedId === row.dataset.id ? null : row.dataset.id;
        render();
      });
    });

    // Action buttons
    container.querySelectorAll('.ops-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const reviewId = btn.dataset.id;
        // Show notes input inline
        const row = btn.closest('tr');
        if (row.querySelector('.ops-notes-form')) return;
        const form = document.createElement('tr');
        form.className = 'ops-notes-row';
        form.innerHTML = `<td colspan="6"><div style="display:flex;gap:8px;padding:8px 0;align-items:center"><textarea class="ops-notes-input" placeholder="${t('ops_rq_notes_placeholder')}" style="flex:1;padding:8px 12px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;min-height:40px;resize:vertical;outline:none"></textarea><button class="btn-sm btn-approve ops-confirm-btn">${t('ops_rq_confirm')}</button></div></td>`;
        row.after(form);
        form.querySelector('.ops-confirm-btn').addEventListener('click', async () => {
          const notes = form.querySelector('.ops-notes-input').value.trim();
          form.querySelector('.ops-confirm-btn').innerHTML = '<span class="spinner"></span>';
          try {
            const fn = firebase.functions().httpsCallable('submitReviewDecision');
            await fn({ reviewId, decision: action, notes });
            const toastKey = action === 'approved' ? 'ops_rq_toast_approved' : action === 'rejected' ? 'ops_rq_toast_rejected' : 'ops_rq_toast_info';
            showToast(t(toastKey), action === 'rejected' ? 'error' : 'success');
            loadReviews();
          } catch (err) { showToast(err.message, 'error'); form.querySelector('.ops-confirm-btn').textContent = t('ops_rq_confirm'); }
        });
      });
    });
  }

  function loadReviews() {
    container.innerHTML = '<div style="padding:40px;text-align:center"><span class="spinner"></span></div>';
    db.collection('review_queue').orderBy('queuedAt', 'desc').get().then(snap => {
      allReviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      expandedId = null;
      render();
    }).catch(err => {
      container.innerHTML = `<div style="padding:40px;color:#c0392b">${err.message}</div>`;
    });
  }

  loadReviews();

  // Auto-refresh SLA timers every 30s
  const slaInterval = setInterval(() => {
    if (!document.getElementById('opsContent')) { clearInterval(slaInterval); return; }
    container.querySelectorAll('.sla-timer').forEach((el, i) => {
      const r = allReviews.filter(r => r.status === 'pending_review')[i];
      if (!r) return;
      const sla = formatSla(r.queuedAt);
      el.textContent = sla.text;
      el.className = 'sla-timer ' + sla.cls;
    });
  }, 30000);
}

// ─── OPS: Portfolio Dashboard ────────────────────────────
function renderOpsPortfolio(container) {
  container.innerHTML = '<div style="padding:40px;text-align:center"><span class="spinner"></span></div>';

  Promise.all([
    db.collection('loans').get(),
    db.collection('employers').where('status', '==', 'active').get(),
    db.collection('portfolio_snapshots').orderBy('snapshotDate', 'desc').limit(12).get(),
  ]).then(([loansSnap, employersSnap, snapshots]) => {
    const loans = loansSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const employers = employersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // KPI calculations
    const activeLoans = loans.filter(l => l.status === 'active');
    const overdueLoans = loans.filter(l => l.status === 'overdue');
    const paidLoans = loans.filter(l => l.status === 'paid');
    const activePortfolio = activeLoans.reduce((s, l) => s + (l.amount || 0), 0);
    const totalOutstanding = activeLoans.reduce((s, l) => s + (l.total || 0), 0) + overdueLoans.reduce((s, l) => s + (l.total || 0), 0);
    const denom = activeLoans.length + overdueLoans.length + paidLoans.length;
    const defaultRate = denom > 0 ? ((overdueLoans.length / denom) * 100).toFixed(1) : '0.0';

    // Status breakdown
    const statuses = ['pending', 'active', 'overdue', 'paid', 'defaulted'];
    const statusCounts = {};
    statuses.forEach(s => { statusCounts[s] = loans.filter(l => l.status === s).length; });
    const maxCount = Math.max(...Object.values(statusCounts), 1);

    // Employer aggregation
    const empAgg = employers.map(emp => {
      const empLoans = loans.filter(l => l.employerId === emp.id);
      const outstanding = empLoans.filter(l => ['active', 'overdue'].includes(l.status)).reduce((s, l) => s + (l.total || 0), 0);
      const totalEmpLoans = empLoans.filter(l => ['active', 'overdue', 'paid'].includes(l.status)).length;
      const paidEmp = empLoans.filter(l => l.status === 'paid').length;
      const compliance = totalEmpLoans > 0 ? ((paidEmp / totalEmpLoans) * 100).toFixed(0) : '—';
      return { name: emp.companyName || emp.name || '—', loans: empLoans.length, outstanding, compliance };
    }).sort((a, b) => b.loans - a.loans).slice(0, 20);

    // Cohort analysis (by origination month)
    const cohorts = {};
    loans.forEach(l => {
      if (!l.createdAt) return;
      const d = new Date(l.createdAt.seconds * 1000);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!cohorts[key]) cohorts[key] = { total: 0, defaulted: 0 };
      cohorts[key].total++;
      if (l.status === 'overdue' || l.status === 'defaulted') cohorts[key].defaulted++;
    });
    const cohortKeys = Object.keys(cohorts).sort().slice(-12);

    // Trend from snapshots
    const trendSnaps = snapshots.docs.map(d => d.data()).reverse();
    const lastRate = trendSnaps.length > 1 ? trendSnaps[trendSnaps.length - 1].overdueRate : null;
    const prevRate = trendSnaps.length > 1 ? trendSnaps[trendSnaps.length - 2].overdueRate : null;
    const trendDir = lastRate != null && prevRate != null ? (lastRate > prevRate ? '↑' : lastRate < prevRate ? '↓' : '→') : '—';

    let html = `<h2 style="font-size:18px;font-weight:700;color:var(--t1);margin:0 0 20px">${t('ops_pf_title')}</h2>`;

    // KPI cards
    html += `<div class="kpi-grid"><div class="kpi-card"><div class="kpi-val">$${fmt(activePortfolio)}</div><div class="kpi-label">${t('ops_pf_active_size')}</div></div><div class="kpi-card"><div class="kpi-val">$${fmt(totalOutstanding)}</div><div class="kpi-label">${t('ops_pf_outstanding')}</div></div><div class="kpi-card${parseFloat(defaultRate)>5?' warn':''}"><div class="kpi-val">${defaultRate}%</div><div class="kpi-label">${t('ops_pf_default_rate')}</div></div><div class="kpi-card"><div class="kpi-val">${trendDir}</div><div class="kpi-label">${t('ops_pf_trend')}</div></div></div>`;

    // Loans by status (bar chart)
    html += `<div class="ops-card"><div class="ops-card-title">${t('ops_pf_by_status')}</div><div class="ops-bar-chart">${statuses.map(s => {
      const count = statusCounts[s] || 0;
      const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
      return `<div class="ops-bar-row"><span class="ops-bar-label">${t('ops_pf_status_' + s)}</span><div class="ops-bar-track"><div class="ops-bar-fill ops-bar-${s}" style="width:${pct}%"></div></div><span class="ops-bar-count">${count}</span></div>`;
    }).join('')}</div></div>`;

    // Employer aggregation table
    html += `<div class="ops-card"><div class="ops-card-title">${t('ops_pf_by_employer')}</div><div class="table-wrap"><table><thead><tr><th>${t('ops_pf_col_employer')}</th><th>${t('ops_pf_col_loans')}</th><th>${t('ops_pf_col_outstanding')}</th><th>${t('ops_pf_col_compliance')}</th></tr></thead><tbody>${empAgg.map(e => `<tr><td style="font-weight:600">${e.name}</td><td>${e.loans}</td><td>$${fmt(e.outstanding)}</td><td>${e.compliance}%</td></tr>`).join('')}</tbody></table></div></div>`;

    // Cohort analysis
    html += `<div class="ops-card"><div class="ops-card-title">${t('ops_pf_cohort')}</div><div class="table-wrap"><table><thead><tr><th>${t('ops_pf_cohort_month')}</th><th>${t('ops_pf_cohort_count')}</th><th>${t('ops_pf_cohort_default')}</th></tr></thead><tbody>${cohortKeys.map(k => {
      const c = cohorts[k];
      const rate = c.total > 0 ? ((c.defaulted / c.total) * 100).toFixed(1) : '0.0';
      return `<tr><td style="font-weight:600">${k}</td><td>${c.total}</td><td style="${parseFloat(rate)>5?'color:#c0392b;font-weight:700':''}">${rate}%</td></tr>`;
    }).join('')}</tbody></table></div></div>`;

    container.innerHTML = html;
  }).catch(err => {
    container.innerHTML = `<div style="padding:40px;color:#c0392b">${err.message}</div>`;
  });
}

// ─── OPS: Employer Management ────────────────────────────
function renderOpsEmployers(container) {
  container.innerHTML = '<div style="padding:40px;text-align:center"><span class="spinner"></span></div>';

  db.collection('employers').orderBy('createdAt', 'desc').get().then(snap => {
    if (snap.empty) { container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--t3)">${t('ops_em_empty')}</div>`; return; }

    const employers = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    function render() {
      let html = `<h2 style="font-size:18px;font-weight:700;color:var(--t1);margin:0 0 20px">${t('ops_em_title')}</h2>`;
      html += `<div class="table-wrap"><table><thead><tr><th>${t('ops_em_col_company')}</th><th>${t('ops_em_col_tier')}</th><th>${t('ops_em_col_score')}</th><th>${t('ops_em_col_slots')}</th><th>${t('ops_em_col_employees')}</th><th>${t('ops_em_col_actions')}</th></tr></thead><tbody>${employers.map(e => {
        const tier = e.riskTier || '—';
        const tierCls = tier === 1 ? 'tier-1' : tier === 2 ? 'tier-2' : tier === 3 ? 'tier-3' : '';
        const score = e.mlScore != null ? e.mlScore : '—';
        const slots = e.maxActiveSlots || '—';
        const empCount = e.employeeCount || 0;
        let actions = '';
        if (tier === 2) {
          actions = `<button class="btn-sm ops-action" data-action="expand" data-id="${e.id}" style="background:var(--aqua);color:var(--brand);margin-right:4px">${t('ops_em_btn_expand')}</button><button class="btn-sm btn-approve ops-action" data-action="upgrade" data-id="${e.id}">${t('ops_em_btn_upgrade')}</button>`;
        }
        actions += ` <button class="btn-sm ops-action" data-action="history" data-id="${e.id}" style="background:rgba(25,68,69,.06);color:var(--t2)">${t('ops_em_btn_history')}</button>`;
        return `<tr><td style="font-weight:600">${e.companyName || e.name || '—'}<div style="font-size:11px;color:var(--t3)">${e.email || ''}</div></td><td><span class="ml-badge ${tierCls}">Tier ${tier}</span></td><td>${score}</td><td>${slots}</td><td>${empCount}</td><td>${actions}</td></tr>`;
      }).join('')}</tbody></table></div>`;

      container.innerHTML = html;

      // Expand slots action
      container.querySelectorAll('[data-action="expand"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('tr');
          if (row.nextElementSibling?.classList.contains('ops-expand-row')) return;
          const form = document.createElement('tr');
          form.className = 'ops-expand-row';
          form.innerHTML = `<td colspan="6"><div style="display:flex;gap:8px;padding:8px 0;align-items:center"><span style="font-size:13px;font-weight:600">${t('ops_em_expand_title')}:</span><input type="number" min="1" class="ops-slots-input" placeholder="${t('ops_em_expand_placeholder')}" style="width:100px;padding:8px 12px;border:1px solid rgba(25,68,69,.12);border-radius:8px;font-size:13px;outline:none"><button class="btn-sm btn-approve ops-expand-confirm">${t('ops_em_expand_confirm')}</button></div></td>`;
          row.after(form);
          form.querySelector('.ops-expand-confirm').addEventListener('click', async () => {
            const newSlots = parseInt(form.querySelector('.ops-slots-input').value);
            if (!newSlots || newSlots < 1) { showToast('Invalid slots', 'error'); return; }
            form.querySelector('.ops-expand-confirm').innerHTML = '<span class="spinner"></span>';
            try {
              const fn = firebase.functions().httpsCallable('updateEmployerTier');
              await fn({ employerId: btn.dataset.id, action: 'approve_expansion', newSlots });
              showToast(t('ops_em_toast_expanded'), 'success');
              // Refresh
              const emp = employers.find(e => e.id === btn.dataset.id);
              if (emp) emp.maxActiveSlots = newSlots;
              render();
            } catch (err) { showToast(err.message, 'error'); form.querySelector('.ops-expand-confirm').textContent = t('ops_em_expand_confirm'); }
          });
        });
      });

      // Upgrade tier action
      container.querySelectorAll('[data-action="upgrade"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.dataset.loading === 'true') return;
          btn.dataset.loading = 'true'; btn.innerHTML = '<span class="spinner"></span>';
          try {
            const fn = firebase.functions().httpsCallable('updateEmployerTier');
            await fn({ employerId: btn.dataset.id, action: 'upgrade_tier' });
            showToast(t('ops_em_toast_upgraded'), 'success');
            const emp = employers.find(e => e.id === btn.dataset.id);
            if (emp) emp.riskTier = 1;
            render();
          } catch (err) { showToast(err.message, 'error'); btn.dataset.loading = 'false'; btn.textContent = t('ops_em_btn_upgrade'); }
        });
      });

      // Screening history
      container.querySelectorAll('[data-action="history"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('tr');
          if (row.nextElementSibling?.classList.contains('ops-history-row')) {
            row.nextElementSibling.remove();
            return;
          }
          const histRow = document.createElement('tr');
          histRow.className = 'ops-history-row';
          histRow.innerHTML = `<td colspan="6"><div style="padding:12px"><h4 style="margin:0 0 8px;font-size:13px;font-weight:700">${t('ops_em_screening')}</h4><div id="hist-${btn.dataset.id}"><span class="spinner"></span></div></div></td>`;
          row.after(histRow);
          db.collection('audit_log').where('targetId', '==', btn.dataset.id).orderBy('timestamp', 'desc').limit(20).get().then(logSnap => {
            const el = document.getElementById('hist-' + btn.dataset.id);
            if (!el) return;
            if (logSnap.empty) { el.innerHTML = `<div style="color:var(--t3);font-size:13px">${t('ops_em_screening_empty')}</div>`; return; }
            el.innerHTML = `<div class="table-wrap"><table style="font-size:12px"><thead><tr><th>Fecha</th><th>Acción</th><th>Actor</th></tr></thead><tbody>${logSnap.docs.map(d => {
              const l = d.data();
              const ts = l.timestamp ? new Date(l.timestamp.seconds * 1000).toLocaleString() : '—';
              return `<tr><td>${ts}</td><td><span class="badge badge-active">${l.action || '—'}</span></td><td>${l.actorUid || '—'}</td></tr>`;
            }).join('')}</tbody></table></div>`;
          });
        });
      });
    }

    render();
  }).catch(err => {
    container.innerHTML = `<div style="padding:40px;color:#c0392b">${err.message}</div>`;
  });
}

// ─── OPS: Alerts / System Health ─────────────────────────
function renderOpsAlerts(container) {
  container.innerHTML = '<div style="padding:40px;text-align:center"><span class="spinner"></span></div>';

  let html = `<h2 style="font-size:18px;font-weight:700;color:var(--t1);margin:0 0 20px">${t('ops_al_title')}</h2>`;

  // Services section
  html += `<div class="ops-card"><div class="ops-card-title">${t('ops_al_services')}</div><div id="opsServicesTable"><div style="padding:20px;text-align:center"><span class="spinner"></span></div></div></div>`;

  // Queue depths
  html += `<div class="ops-card"><div class="ops-card-title">${t('ops_al_queues')}</div><div id="opsQueuesTable"><div style="padding:20px;text-align:center"><span class="spinner"></span></div></div></div>`;

  // Model drift indicators
  html += `<div class="ops-card"><div class="ops-card-title">${t('ops_al_drift')}</div><div id="opsDriftTable"><div style="padding:20px;text-align:center"><span class="spinner"></span></div></div></div>`;

  container.innerHTML = html;

  // Live service health
  window._opsUnsubs.push(
    db.collection('system_health').doc('current').onSnapshot(doc => {
      const el = document.getElementById('opsServicesTable');
      if (!el) return;
      if (!doc.exists) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--t3)">${t('ops_al_empty')}</div>`; return; }
      const d = doc.data();
      const services = Object.entries(d).filter(([k]) => k !== 'lastChecked');
      if (!services.length) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--t3)">${t('ops_al_empty')}</div>`; return; }
      el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('ops_al_col_service')}</th><th>${t('ops_al_col_status')}</th><th>${t('ops_al_col_latency')}</th><th>${t('ops_al_col_checked')}</th></tr></thead><tbody>${services.map(([name, v]) => {
        const statusCls = v.status === 'ok' ? 'ops-status-ok' : v.status === 'degraded' ? 'ops-status-warn' : 'ops-status-down';
        const statusLabel = v.status === 'ok' ? t('ops_al_status_ok') : v.status === 'degraded' ? t('ops_al_status_degraded') : t('ops_al_status_down');
        const latency = v.latencyMs != null ? v.latencyMs + 'ms' : '—';
        const checked = v.checkedAt?.seconds ? new Date(v.checkedAt.seconds * 1000).toLocaleTimeString() : '—';
        return `<tr><td style="font-weight:600">${name}</td><td><span class="ops-status-pill ${statusCls}">${statusLabel}</span></td><td>${latency}</td><td>${checked}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    })
  );

  // Live queue depths
  window._opsUnsubs.push(
    db.collection('system_health').doc('queues').onSnapshot(doc => {
      const el = document.getElementById('opsQueuesTable');
      if (!el) return;
      if (!doc.exists) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--t3)">${t('ops_al_empty')}</div>`; return; }
      const q = doc.data();
      const queues = Object.entries(q).filter(([k]) => k !== 'checkedAt');
      if (!queues.length) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--t3)">${t('ops_al_empty')}</div>`; return; }
      el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('ops_al_col_queue')}</th><th>${t('ops_al_col_waiting')}</th><th>${t('ops_al_col_active')}</th><th>${t('ops_al_col_failed')}</th><th>${t('ops_al_col_completed')}</th></tr></thead><tbody>${queues.map(([name, v]) => {
        const failed = v.failed || 0;
        return `<tr><td style="font-weight:600">${name}</td><td>${v.waiting || 0}</td><td>${v.active || 0}</td><td style="${failed>0?'color:#c0392b;font-weight:700':''}">${failed}</td><td>${v.completed || 0}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    })
  );

  // Model drift — read from system_health/model_drift if available
  db.collection('system_health').doc('model_drift').get().then(doc => {
    const el = document.getElementById('opsDriftTable');
    if (!el) return;
    if (!doc.exists) {
      el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('ops_al_drift_status')}</th><th>PSI</th><th>CSI</th></tr></thead><tbody><tr><td><span class="ops-status-pill ops-status-ok">${t('ops_al_drift_ok')}</span></td><td>—</td><td>—</td></tr></tbody></table></div>`;
      return;
    }
    const d = doc.data();
    const psiStatus = (d.psi || 0) < 0.1 ? 'ok' : (d.psi || 0) < 0.25 ? 'warning' : 'alert';
    const csiStatus = (d.csi || 0) < 0.1 ? 'ok' : (d.csi || 0) < 0.25 ? 'warning' : 'alert';
    const psiCls = psiStatus === 'ok' ? 'ops-status-ok' : psiStatus === 'warning' ? 'ops-status-warn' : 'ops-status-down';
    const csiCls = csiStatus === 'ok' ? 'ops-status-ok' : csiStatus === 'warning' ? 'ops-status-warn' : 'ops-status-down';
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th></th><th>${t('ops_al_drift_status')}</th><th>Value</th></tr></thead><tbody><tr><td style="font-weight:600">${t('ops_al_drift_psi')}</td><td><span class="ops-status-pill ${psiCls}">${t('ops_al_drift_' + psiStatus)}</span></td><td>${(d.psi || 0).toFixed(4)}</td></tr><tr><td style="font-weight:600">${t('ops_al_drift_csi')}</td><td><span class="ops-status-pill ${csiCls}">${t('ops_al_drift_' + csiStatus)}</span></td><td>${(d.csi || 0).toFixed(4)}</td></tr></tbody></table></div>`;
  });
}

// ─── Device Fingerprint (Stage 0 fraud detection) ────────
async function getDeviceFingerprint() {
  try {
    const fp = await window._fpPromise;
    const result = await fp.get();
    return result.visitorId;
  } catch (e) {
    console.warn("Fingerprint unavailable:", e.message);
    return null;
  }
}

// ─── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.lang = currentLang;
  router();
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('/') && !href.startsWith('//')) { e.preventDefault(); navigate(href); }
  });
});
