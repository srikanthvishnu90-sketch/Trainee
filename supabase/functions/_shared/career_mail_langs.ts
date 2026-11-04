// WO-046: status words in six more languages (Spanish, Portuguese, French, German, Italian, Dutch), as data. classifyMail
// (career_mail.ts) reads a message in English always and, when most of its words are in one of these languages, in that
// language too. Each language has the same parts the English reader has, one list per part, so a missed wording is found
// and fixed in one place:
//   - marks:      common words that say a message is in this language;
//   - rules:      strong phrases, as the English RULES (each sets the feature rule:<kind>);
//   - families:   word families that set the SAME features the English families do (rc:got, rj:pass, iv:noun, ...), so the
//                 weights fitted on the tuning splits read them the same way and nothing is fitted per language;
//   - negators and progress: a negator in front of a verb of progress in the same clause is a decision against the person
//                 (rj:negated): "leider ... nicht berücksichtigen", "lamentablemente no podemos seguir", "malheureusement
//                 ... n'a pas été retenue", "infelizmente não seguirá", "purtroppo non possiamo procedere", "helaas niet
//                 verder";
//   - noDecision: a clause a negation decides nothing in (a condition, an instruction, other people);
//   - past/maybe: a step already done ("gracias por la entrevista") or one that may come ("si tu perfil avanza") is
//                 removed before the forward families read the text, as in English;
//   - job:        job words (the English JOB_CUE and APP_REF);
//   - noise:      alerts, newsletters, surveys and advice (subject) and practice and unsubscribe words (text);
//   - notJob:     applications that are not for a job (a card, a loan, a flat);
//   - recruiter:  words a recruiter's reply refers to ("tu candidatura", "Ihre Bewerbung").
// Every pattern is read on normText's output (lower case, straight quotes), with letter-aware word edges (\b in a
// JavaScript regex does not know "é" is a letter). Pure data and regexes: no model, no network, no clock.

export type Lang = "es" | "pt" | "fr" | "de" | "it" | "nl";
type Kind = "received" | "rejection" | "interview" | "assessment" | "offer";
interface LangWords {
  marks: string[];
  rules: Partial<Record<Kind, string[]>>;
  families: Record<string, string[]>;
  negators: string[];
  progress: string[];
  noDecision: string[];
  past: string[];
  maybe: string[];
  job: string[];
  noiseSubject: string[];
  noiseText: string[];
  notJob: string[];
  recruiter: string[];
}

const ES: LangWords = {
  marks: ["hola", "gracias", "hemos", "nuestro", "nuestra", "nuestros", "usted", "del", "los", "las", "el", "estimado", "estimada", "saludos", "puesto", "vacante", "postulación", "equipo", "selección", "también", "gustaría", "lamentablemente", "tienes", "estamos", "queremos", "podemos", "muchas", "enlace", "correo", "tras", "y", "muy", "contigo", "nos", "tu", "su"],
  rules: {
    received: [
      "(hemos|ya hemos) recibido (correctamente |con éxito )?(tu|su) (candidatura|solicitud|postulación|aplicación|hoja de vida|cv|currículum)",
      "recibimos (tu|su) (candidatura|solicitud|postulación|hoja de vida|cv|currículum)",
      "(tu|su) (candidatura|postulación|solicitud)[^.]{0,80}? (ha sido |fue |se ha |quedó )?(recibid[oa]|registrad[oa])",
      "confirmación de (recepción|tu candidatura|su candidatura|postulación|candidatura)",
      "acuse de recibo",
    ],
    rejection: [
      "no (has sido|ha sido|fuiste|fue|has resultado|ha resultado) (seleccionad[oa]|elegid[oa]|preseleccionad[oa])",
      "(decidido|optado|elegido) (por )?(continuar|avanzar|seguir|proseguir)( el proceso| adelante)? con (otr[oa]s?|el resto de) (candidat|perfil|postulant)\\p{L}*",
      "no (podemos|podremos|vamos a|continuaremos|seguiremos|avanzaremos) (seguir |continuar |avanzar )?(adelante )?con (tu|su) (candidatura|postulación|proceso|perfil)",
      "no continuar(á|ás|emos)[^.]{0,30}(proceso|selección)",
      "(vacante|posición|puesto|plaza)[^.]{0,40}? (ha sido|fue|se ha) (cubiert[oa]|cerrad[oa]|cancelad[oa])",
      "hemos decidido no (avanzar|continuar|seguir|proseguir)",
      "(tu|su) (candidatura|postulación)[^.]{0,40}? no (ha sido|fue) (seleccionad|aceptad|considerad)\\p{L}*",
    ],
    interview: [
      "invitación (a|para) (una |la )?entrevista",
      "(te|le|les) (invitamos|convocamos|citamos) a (una |la |tu |su )?([\\p{L}-]+ ){0,2}entrevista",
      "convocatoria (a|para) (una |la )?entrevista",
      "entrevista (programada|confirmada|agendada)",
      "(agenda|programa|reserva) (tu|su|una) entrevista",
      "(segunda|primera|tercera|próxima|siguiente) entrevista",
      "(nos gustaría|queremos|quisiéramos) (tener una entrevista|entrevistarte|entrevistarle)",
      // Family email (2026-10-26): the invitation itself, "nos gustaría invitarte a una entrevista" (French, German,
      // Portuguese and Italian already read their own "inviter à un entretien", "zu einem Vorstellungsgespräch einladen").
      "(nos gustaría|queremos|quisiéramos|me gustaría|deseamos) invitar(te|le|les) a (una |la |tu |su )?([\\p{L}-]+ ){0,2}entrevista",
      // WO-050: an interview moved or confirmed ("hemos tenido que mover tu entrevista", "cambio de hora de tu entrevista").
      "(mover|cambiar|reprogramar|reagendar|aplazar|posponer|movido|cambiado|reprogramado) (tu|su|la) entrevista",
      "cambio de (hora|fecha|horario) de (tu|su|la) entrevista",
      "(te |le )?confirmamos (tu|su|la) entrevista",
    ],
    assessment: [
      // WO-050: a one-way video interview is a test, as in English.
      "entrevista (en |por )?v[íi]deo (diferida|grabada|asíncrona)",
      "graba(r)? (tus|sus) respuestas",
      "prueba (técnica|online|en línea|de conocimientos|psicotécnica|práctica)",
      "test (online|en línea|técnico|psicotécnico|de lógica|de personalidad|de inglés|de aptitud)",
      "(desafío|reto) técnico",
      "caso práctico",
      "evaluación (técnica|online|en línea|psicométrica)",
    ],
    offer: [
      "carta (de )?oferta",
      "oferta formal",
      "(nos complace|tenemos el gusto de|es un placer|nos da mucho gusto) (ofrecerte|ofrecerle|hacerte una oferta|hacerle una oferta)",
      "propuesta (laboral|económica|de contratación|formal)",
    ],
  },
  families: {
    "rc:got": [
      "(recibido|recibimos)[^.]{0,20}(tu|su) (candidatura|solicitud|postulación|hoja de vida|cv|currículum|perfil)",
      "(tu|su) (candidatura|postulación|solicitud)[^.]{0,60}? (ha llegado|está en nuestras manos|se ha registrado|ha sido registrada|fue registrada)",
      "confirm\\p{L}* (que )?(hemos recibido|la recepción|recepción)",
    ],
    "rc:thanks": [
      "gracias por (tu|su) (candidatura|postulación|interés|solicitud)",
      "gracias por (postularte|postular|aplicar|inscribirte)",
      "agradecemos (tu|su) (interés|candidatura|postulación)",
    ],
    "rc:review": [
      "revisaremos|revisará|revisarán|estamos revisando|será revisad[oa]|la revisará|lo revisará|en revisión|analizaremos|evaluaremos|valoraremos",
      "(te|le) (contactaremos|escribiremos|avisaremos)[^.]{0,40}(si|cuando|en cuanto|en caso)",
    ],
    "rj:other_candidate": [
      "(continuar|avanzar|seguir|proseguir|optado|decidido|elegido|seleccionado)[^.]{0,40}? (con |por )?otr[oa]s? (candidat|perfil|postulant)\\p{L}*",
      "otr[oa]s? (candidat|postulant)\\p{L}* (cuyo|cuyos|que)",
    ],
    "rj:closed": ["(vacante|posición|puesto|plaza)[^.]{0,40}? (ha sido|fue|se ha|está) (cubiert[oa]|cerrad[oa]|cancelad[oa]|congelad[oa])"],
    "rj:pass": ["no (has sido|ha sido|fuiste|fue)[^.]{0,20}? (seleccionad|elegid|aceptad)\\p{L}*", "descartad[oa]"],
    "rj:regret": ["lamentablemente", "lamentamos", "desafortunadamente", "por desgracia", "sentimos (informarte|informarle|comunicarte|comunicarle)"],
    "rj:closer": ["(te|le) deseamos (mucho |el mayor |todo el )?(éxito|suerte)", "mucho éxito"],
    "rj:future": ["(guardaremos|conservaremos|mantendremos|tendremos en cuenta) (tu|su) (cv|currículum|perfil|candidatura|hoja de vida)", "futur[oa]s (vacantes|oportunidades|procesos|posiciones)", "base de datos", "(postular|aplicar) a otras vacantes"],
    "rj:decision": ["en esta (ocasión|oportunidad)", "(decisión|elección) (difícil|complicada)"],
    "iv:noun": ["entrevistas?", "videoentrevista"],
    "iv:talk": ["llamada", "videollamada", "charla", "conversación", "reunión", "platicar", "plática"],
    "iv:invite": [
      "(nos gustaría|queremos|quisiéramos|me gustaría) (invitarte|invitarle|conocerte|conocerle|entrevistarte|platicar|tener una entrevista|hablar contigo)",
      "(te|le) (invitamos|convocamos|citamos|esperamos)",
      "invitación a",
      "(has|ha) (superado|pasado) (la primera|el primer|a la siguiente)",
      "pasaste (el primer|a la siguiente)",
    ],
    "iv:schedule": [
      "(agenda|agendar|programar|reserva|reservar|elige|elegir|eligiendo|escoge|selecciona|indica|indícanos)[^.]{0,20}(horario|hora|día|fecha|entrevista|disponibilidad)",
      "disponibilidad",
      "(te|le) (encaja|viene bien|queda bien|funciona)",
      "horarios? disponibles?",
    ],
    "iv:when": ["lunes|martes|miércoles|jueves|viernes|sábado|domingo", "a las \\d{1,2}", "\\d{1,2}[:.]\\d\\d ?h"],
    "iv:who": ["con (el|la) (director|directora|gerente|responsable|jefe|jefa|hiring manager|líder)"],
    "as:noun": ["pruebas?", "test", "desafío", "reto", "caso práctico", "ejercicio"],
    "as:do": ["completarla|completarlo|resolverla|resolverlo|realizarla|realizarlo", "(completar|realizar|resolver|hacer|responder) (la |el |una |un )?(prueba|test|desafío|reto|ejercicio|caso|evaluación)"],
    "as:deadline": ["(tienes|tiene|dispones de|dispone de|cuentas con) (\\d+|una|un|dos|tres|cinco|siete) (horas|días|semana|semanas)", "plazo", "fecha límite", "antes del? (día )?\\d"],
    "x:minutes": ["\\d+ ?(minutos|min)"],
    "x:next_step": ["(siguiente|próximo) paso", "(siguiente|próxima) (fase|etapa)"],
    "of:noun": ["carta (de )?oferta", "oferta formal", "propuesta (laboral|económica|formal|de contratación)", "contrato (de trabajo|laboral)"],
    "of:extend": ["ofrecerte|ofrecerle|ofrecemos", "hacerte una (oferta|propuesta)"],
    "of:joy": ["enhorabuena", "felicidades", "felicitaciones", "bienvenid[oa] al equipo", "queremos que te unas", "es oficial"],
    "of:sign": ["firmar|firmes|firma", "salario", "remuneración", "prestaciones", "fecha de (inicio|incorporación)", "beneficios"],
    "rr:status": [
      "(seguimos|sigue|estamos) (revisando|en (el )?proceso|evaluando)",
      "(sigue|está) en revisión",
      "(todavía|aún) no (tenemos|hay|he tenido) (una )?(decisión|novedades|noticias|respuesta|feedback)",
      "(apenas|en cuanto|cuando) (tenga|tengamos|sepa) (novedades|algo|noticias)",
      "(podrías|puedes|podría|puede) (compartir|enviar|mandar)(me|nos)?",
      "(expectativa|pretensión|pretensiones) salarial(es)?",
      "lo paso al",
    ],
  },
  negators: ["no", "ya no", "nunca"],
  progress: ["seguir\\p{L}*", "seguiremos", "continu\\p{L}*", "avanz\\p{L}*", "prosegui\\p{L}*", "seleccionad\\p{L}*", "elegid\\p{L}*", "considerad\\p{L}*", "ofrec\\p{L}*", "contar contigo", "encaja\\p{L}*", "se ajusta", "invitar\\p{L}*", "proced\\p{L}*"],
  noDecision: ["^\\s*(si|en caso de|a menos que)", "no (dudes|dude|olvides|responda|respondas)", "(los|las) (candidat|postulant)\\p{L}* (que|cuyos) no", "(aún|todavía) no (has|ha) (completado|terminado|enviado)"],
  past: ["gracias (de nuevo |nuevamente |otra vez )?por (la entrevista|tu tiempo|su tiempo|participar|el tiempo dedicado|la conversación)[^.]*"],
  maybe: ["(si|en caso de que) (tu perfil|tu candidatura|su perfil|su candidatura|eres|resultas|quedas|avanzas)[^.]*"],
  job: ["candidat\\p{L}*", "postula\\p{L}*", "vacantes?", "puesto", "posición", "selección", "entrevistas?", "currículum", "hoja de vida", "cv", "reclutamiento", "empleo", "prácticas", "becari[oa]"],
  noiseSubject: ["ofertas de (empleo|trabajo)", "empleos? para ti", "boletín", "consejos para", "encuesta", "webinar", "feria de empleo", "qué tal la entrevista", "cómo te fue"],
  noiseText: ["simulación de entrevista", "entrevista simulada", "darte de baja", "cancelar (tu )?suscripción", "en el boletín"],
  notJob: ["solicitud de (préstamo|tarjeta|crédito|hipoteca|alquiler|cuenta)", "tarjeta de crédito", "préstamo personal", "alquiler", "inquilino"],
  recruiter: ["(tu|su) (candidatura|postulación|cv|currículum|perfil|hoja de vida)"],
};

const PT: LangWords = {
  marks: ["olá", "oi", "obrigado", "obrigada", "você", "vc", "sua", "seu", "não", "vaga", "nosso", "nossa", "em", "uma", "com", "ao", "à", "os", "do", "dos", "das", "está", "atenciosamente", "abraços", "abs", "prezado", "prezada", "seletivo", "currículo", "também", "pela", "pelo", "muito", "agradecemos", "infelizmente", "gostaríamos", "equipa", "tudo", "você"],
  rules: {
    received: [
      "recebemos (a |o )?(sua|seu|tua|teu) (candidatura|inscrição|currículo|cv|aplicação)",
      "(sua|tua) (candidatura|inscrição)[^.]{0,80}? (foi |está )?(recebida|registrada|registada|enviada) (com sucesso|corretamente)",
      "(sua|tua) (candidatura|inscrição)[^.]{0,80}? foi (recebida|registrada|registada)",
      "confirma(mos|ção de) (a )?(receção|recepção|recebimento)",
      "candidatura recebida",
    ],
    rejection: [
      "não (foi|foram|fomos) (selecionad|aprovad|escolhid)\\p{L}*",
      "(optamos|decidimos|escolhemos) (por )?(seguir|prosseguir|continuar|avançar)[^.]{0,30}? com outr[oa]s? (candidat|perfi|profissiona)\\p{L}*",
      "não (poderemos|podemos|vamos|iremos|conseguiremos) (seguir|prosseguir|continuar|avançar)[^.]{0,20}? com (a |o )?(sua|seu|tua|teu)",
      "não seguirá para",
      "vaga[^.]{0,40}? (foi |está |já foi )?(encerrada|preenchida|cancelada)",
      "processo (seletivo )?(foi )?encerrado",
      "decidimos não (avançar|seguir|prosseguir|continuar)",
    ],
    interview: [
      "convite para (a |uma )?entrevista",
      "(gostaríamos de|queremos) (te |lhe |o |a )?(convidar|convidá-l[oa])[^.]{0,30}entrevista",
      "entrevista (agendada|confirmada|marcada)",
      "(aprovad[oa]|selecionad[oa]) para (a )?(etapa de |fase de )?entrevista",
      "agende (a )?sua entrevista",
      "(primeira|segunda) entrevista",
      // WO-050: moved, and the formal "temos o prazer de o convidar para uma entrevista".
      "(remarcar|reagendar|alterar|adiar) (a )?(sua )?entrevista",
      "remarcação da (sua )?entrevista",
      "(prazer de|vimos) (o |a |te |lhe )?(convidar|convidá-l[oa])[^.]{0,30}entrevista",
    ],
    assessment: ["teste (online|técnico|de lógica|de inglês|de perfil)", "prova (técnica|online|prática)", "desafio técnico", "case (técnico|prático|de produto)"],
    offer: ["carta[- ]proposta", "proposta (de trabalho|de emprego|formal|salarial)", "(temos o prazer de|gostaríamos de) (te |lhe )?(oferecer|fazer uma proposta|propor)", "oferecer a você a vaga"],
  },
  families: {
    "rc:got": [
      "recebemos[^.]{0,15}(sua|seu|tua|teu) (candidatura|inscrição|currículo|cv)",
      "(sua|seu) (candidatura|currículo|inscrição)[^.]{0,60}? (chegou|foi registrad|foi recebid)\\p{L}*",
      "confirm\\p{L}* (a )?(receção|recepção|recebimento)",
    ],
    "rc:thanks": ["obrigad[oa] por (se candidatar|se inscrever|sua candidatura|seu interesse|candidatar-se)", "agradecemos (o |seu |o seu |sua )?(interesse|candidatura)"],
    "rc:review": ["(vamos|iremos|vai|irá) (analisar|avaliar)", "analisá-la|avaliá-la|analisá-lo", "em análise", "entraremos em (contacto|contato)", "você receberá atualizações"],
    "rj:other_candidate": ["(seguir|prosseguir|continuar|avançar|optamos|decidimos|escolhemos)[^.]{0,40}? com outr[oa]s? (candidat|perfi|profissiona)\\p{L}*"],
    "rj:closed": ["vaga[^.]{0,40}? (foi |está |já foi )?(encerrada|preenchida|cancelada|congelada)", "processo (seletivo )?(foi )?encerrado"],
    "rj:pass": ["não (foi|foram) (selecionad|aprovad)\\p{L}*", "não seguirá"],
    "rj:regret": ["infelizmente", "lamentamos"],
    "rj:closer": ["desej(amos|o) (muito )?(sucesso|boa sorte)", "torcemos pelo (seu )?sucesso", "muito sucesso"],
    "rj:future": ["(seu|o seu) currículo (ficará|continuará|permanecerá)", "banco de talentos", "em nossa base", "futuras oportunidades", "outras oportunidades"],
    "rj:decision": ["nesta (etapa|oportunidade)", "desta vez", "após análise cuidadosa"],
    "iv:noun": ["entrevistas?"],
    "iv:talk": ["bate-papo", "conversa", "reunião", "chamada", "videochamada", "ligação"],
    "iv:invite": [
      "(gostaríamos de|queremos) (te |lhe |o |a )?(convidar|convidá-l[oa]|conhecer)",
      "convite para",
      "(te|lhe) convidamos",
      "(você foi|foi) (aprovad[oa]|selecionad[oa]) para",
      "você avançou",
      "(queria|quero|gostaria de) (marcar|agendar)",
    ],
    "iv:schedule": ["(escolha|escolher|selecione|agende|agendar|marque|marcar)[^.]{0,20}(horário|dia|data|entrevista|bate-papo)", "disponibilidade", "qual horário", "melhor horário"],
    "iv:when": ["(segunda|terça|quarta|quinta|sexta)-feira", "sábado", "às \\d{1,2}", "\\d{1,2}h\\d\\d", "\\d{1,2}h"],
    "iv:who": ["com (a|o) (gestora?|gerente|diretora?|líder|coordenadora?)"],
    "as:noun": ["teste", "prova", "desafio", "case", "exercício"],
    "as:do": ["realizá-lo|realizá-la|resolvê-lo|resolvê-la|completá-lo|completá-la", "(realizar|resolver|completar|fazer|responder) (o |a |um |uma )?(teste|prova|desafio|case|exercício)", "resolva"],
    "as:deadline": ["(você tem|tem|terá|prazo de) (\\d+|um|uma|dois|três|cinco|sete) (horas|dias|semanas?)", "até (o dia |a )?(segunda|terça|quarta|quinta|sexta|\\d)", "prazo"],
    "x:minutes": ["\\d+ ?(minutos|min)"],
    "x:next_step": ["próxima (etapa|fase)", "próximo passo"],
    "of:noun": ["carta[- ]proposta", "proposta (formal|de trabalho|de emprego|salarial)", "contrato de trabalho"],
    "of:extend": ["oferecer a você", "(oferecer|oferecemos)(-lhe|-te)? (a vaga|a posição|o cargo)", "fazer uma proposta", "te mandei a proposta"],
    "of:joy": ["parabéns", "que alegria", "queremos você no time", "bem-vind[oa] (ao|à)"],
    "of:sign": ["assinatura", "assinar", "salário", "remuneração", "data de início", "benefícios"],
    "rr:status": [
      "ainda (está |estamos |segue )?(em análise|em processo|avaliando|analisando)",
      "(assim que|quando) (tiver|tivermos) (novidades|retorno|feedback)",
      "devo ter novidades",
      "(pode|poderia) (me )?(mandar|enviar|enviar-me|compartilhar)",
      "pretensão salarial",
      "(sem|ainda sem) (retorno|novidades)",
    ],
  },
  negators: ["não", "nunca", "já não"],
  progress: ["seguir\\p{L}*", "seguirá", "prosseguir\\p{L}*", "continu\\p{L}*", "avanç\\p{L}*", "selecionad\\p{L}*", "aprovad\\p{L}*", "considerad\\p{L}*", "oferecer\\p{L}*", "convidar\\p{L}*"],
  noDecision: ["^\\s*(caso|se|a menos que)", "não (hesite|deixe de|responda)", "candidatos que não"],
  past: ["obrigad[oa] (pela|por) (entrevista|conversa|participação|seu tempo|a conversa)[^.]*"],
  maybe: ["(caso|se) (o seu |a sua |seu |sua )?(perfil|candidatura) (seja|for) (selecionad|aprovad)[^.]*", "(caso|se) (você )?(seja|for) (selecionad|aprovad)[^.]*"],
  job: ["candidat\\p{L}*", "vagas?", "processo seletivo", "seleção", "entrevistas?", "currículo", "cv", "recrutamento", "emprego", "estágio", "trainee", "inscrição"],
  noiseSubject: ["novas vagas", "vagas para você", "vagas recomendadas", "pesquisa", "newsletter", "como foi sua experiência", "dicas", "boa sorte na entrevista"],
  noiseText: ["simulado de entrevista", "entrevista simulada", "dicas para (sua |a )?entrevista", "cancelar inscrição", "descadastrar", "a pesquisa leva"],
  notJob: ["cartão( de crédito)?", "empréstimo", "financiamento", "conta (corrente|digital)"],
  recruiter: ["(sua|seu|tua|teu) (candidatura|currículo|cv|perfil)"],
};

const FR: LangWords = {
  marks: ["bonjour", "merci", "nous", "vous", "votre", "vos", "les", "des", "est", "une", "pour", "avec", "cordialement", "candidature", "poste", "madame", "monsieur", "au", "aux", "du", "et", "qui", "dans", "sur", "pas", "ne", "malheureusement", "souhaitons", "avons", "sommes", "été", "entretien", "salut", "ton", "suite", "notre"],
  rules: {
    received: [
      "(nous avons|avons) bien reçu (votre|ta) candidature",
      "(votre|ta) candidature[^.]{0,80}? (a bien été|a été|est bien) (reçue|enregistrée|transmise|prise en compte)",
      "accus(é|ons) (de )?réception",
      "confirmation de (réception|votre candidature|candidature)",
    ],
    rejection: [
      "n'a pas été (retenue?|sélectionnée?|acceptée?)",
      "pas été (retenue?|sélectionnée?)",
      "ne (pouvons|pourrons|sommes) pas (en mesure de )?(donner (une )?suite|poursuivre|retenir)",
      "ne pas (donner suite|poursuivre)",
      "(retenu|choisi|privilégié|sélectionné) (un autre|une autre|d'autres) (candidat|profil|candidature)\\p{L}*",
      "poste[^.]{0,40}? a été (pourvu|attribué|supprimé|annulé)",
      "sans suite",
    ],
    interview: [
      "(invitation|convocation) (à|a) un entretien",
      "convocation[^.]{0,30}entretien",
      "(convier|inviter|rencontrer)[^.]{0,30}entretien",
      "entretien (confirmé|planifié|programmé|final)",
      "planifiez votre entretien",
      // WO-050: moved or confirmed ("nous devons décaler votre entretien", "nous vous confirmons votre entretien").
      "(décaler|reporter|déplacer|reprogrammer|décalé|reporté|déplacé) (votre|l')\\s?entretien",
      "report de (votre|l')\\s?entretien",
      "(vous )?confirm(ons|ation de) (votre|l')\\s?entretien",
    ],
    assessment: ["test (en ligne|technique|de personnalité|de logique|d'aptitude|psychométrique)", "étude de cas", "cas pratique", "exercice technique", "évaluation en ligne",
      // WO-050: a one-way video interview is a test.
      "entretien (vidéo )?différé", "enregistrer vos réponses"],
    offer: ["promesse d'embauche", "proposition (d'embauche|de contrat|de poste)", "lettre d'offre", "(avons le plaisir|sommes heureux|sommes ravis) de vous (proposer|offrir) le poste"],
  },
  families: {
    "rc:got": ["bien reçu (votre|ta) candidature", "(votre|ta) candidature[^.]{0,60}? (a bien été|a été) (reçue|enregistrée)", "accus\\p{L}* (de )?réception", "nous avons reçu"],
    "rc:thanks": ["(merci|nous vous remercions|je vous remercie) (pour|de) (votre candidature|ta candidature|l'intérêt|votre intérêt|avoir postulé)", "merci d'avoir postulé"],
    "rc:review": ["(l')?étudierons", "sera (étudiée|examinée|analysée)", "examinerons", "reviendrons vers vous", "vous tient au courant", "dans les meilleurs délais", "suivre son statut"],
    "rj:other_candidate": ["(retenu|choisi|privilégié|sélectionné|poursuivre avec|continuer avec)[^.]{0,20}? (un autre|une autre|d'autres) (candidat|profil|candidature)\\p{L}*"],
    "rj:closed": ["poste[^.]{0,60}? (a été|est) (pourvu|attribué|supprimé|annulé|fermé|clôturé)", "(recrutement|processus) (est )?(clos|clôturé|terminé)"],
    "rj:pass": ["(pas été|non) (retenue?|sélectionnée?)", "ne (pas|plus) donner suite", "pas en mesure de (poursuivre|donner suite)"],
    "rj:regret": ["malheureusement", "au regret", "regrettons", "désolée?s?"],
    "rj:closer": ["(nous vous souhaitons|je vous souhaite|je te souhaite)[^.]{0,30}(réussite|succès|meilleur|bonne chance)", "bonne continuation", "pleine réussite"],
    "rj:future": ["(conserverons|garderons|gardons) (votre|ton|ta|vos) (cv|candidature|profil|coordonnées)", "vivier", "futures? (opportunités|offres)", "base de données"],
    "rj:decision": ["après (étude|examen|analyse) (attentive|approfondie)", "après réflexion", "cette fois"],
    "iv:noun": ["entretiens?", "entrevue"],
    "iv:talk": ["échange", "appel", "visio(conférence)?", "rencontre", "rendez-vous", "réunion", "téléphonique"],
    "iv:invite": [
      "(souhaiterions|aimerions|voudrions|souhaitons|j'aimerais) vous (rencontrer|inviter|convier)",
      "(avons le plaisir de|sommes heureux de) vous (convier|inviter|rencontrer)",
      "vous passez à l'étape suivante",
      "j'aimerais organiser",
      "retenu notre attention",
    ],
    "iv:schedule": ["(choisissez|choisir|réservez|réserver|sélectionnez|planifiez|planifier|organiser)[^.]{0,20}(créneau|horaire|date|entretien|échange)", "(vos|tes) disponibilités", "créneau", "confirmer (votre|ta) présence"],
    "iv:when": ["lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche", "à \\d{1,2} ?h", "\\d{1,2}h\\d\\d"],
    "iv:who": ["avec (le|la) (directeur|directrice|manager|responsable|recruteur|recruteuse)"],
    "as:noun": ["tests?", "évaluation en ligne", "cas pratique", "étude de cas", "exercice", "questionnaire"],
    "as:do": ["(passer|compléter|réaliser|effectuer|rendre|soumettre) (le |un |l'|votre |ce |cette )?(test|évaluation|exercice|cas|questionnaire)", "me le rendre"],
    "as:deadline": ["(vous avez|tu as|dans les|sous) \\d+ (heures|jours)", "avant le \\d", "date limite", "délai"],
    "x:minutes": ["\\d+ ?(minutes|min)"],
    "x:next_step": ["prochaine étape", "étape suivante"],
    "of:noun": ["promesse d'embauche", "proposition (d'embauche|de contrat|de poste)", "lettre d'offre", "contrat de travail"],
    "of:extend": ["vous (proposer|offrir) le poste", "t'accueillir"],
    "of:joy": ["félicitations", "bienvenue (dans|parmi)", "bonne nouvelle"],
    "of:sign": ["signature", "signer", "salaire", "rémunération", "date (de démarrage|de début|d'arrivée|de prise de poste)"],
    "rr:status": [
      "(toujours|encore) en cours",
      "(je|nous) (reviens|reviendrons|revenons) vers (vous|toi) (dès|quand)",
      "(pourriez|pouvez)-vous (me |nous )?(transmettre|envoyer|faire parvenir)",
      "prétentions salariales",
      "pas encore de (retour|décision)",
      "en congés",
    ],
  },
  negators: ["ne", "n'\\p{L}*"],
  progress: ["retenu\\p{L}*", "poursuiv\\p{L}*", "poursuivre", "donner (une )?suite", "suite favorable", "sélectionn\\p{L}*", "continu\\p{L}*", "proposer", "convier", "inviter", "avancer", "correspond\\p{L}*"],
  noDecision: ["^\\s*(si|s'il|sauf si|au cas où)", "n'hésitez pas", "ne pas (hésiter|répondre)", "candidat\\p{L}* qui ne"],
  past: ["merci (encore |beaucoup )?(pour|de) (l'entretien|votre temps|ton temps|cet échange|notre échange|votre participation)[^.]*", "suite à (notre|votre) entretien[^.]*"],
  maybe: ["si (votre candidature|votre profil|vous êtes) (est )?(retenue?|sélectionnée?|présélectionnée?)[^.]*"],
  job: ["candidat\\p{L}*", "postul\\p{L}*", "poste", "recrutement", "entretiens?", "cv", "stage", "alternance", "emploi", "embauche"],
  noiseSubject: ["offres d'emploi", "nouvelles offres", "donnez votre avis", "atelier", "newsletter", "enquête", "webinaire"],
  noiseText: ["simulation d'entretien", "conseils pour (votre |réussir )?entretien", "se désabonner", "réussir son entretien"],
  notJob: ["dossier de location", "carte (de crédit|bancaire)", "demande de (prêt|crédit)", "propriétaire", "appartement"],
  recruiter: ["(votre|ta) (candidature|cv|profil|relance)"],
};

const DE: LangWords = {
  marks: ["sehr", "geehrte", "geehrter", "hallo", "vielen", "dank", "danke", "ihre", "ihr", "ihnen", "wir", "sie", "und", "der", "die", "das", "den", "dem", "für", "mit", "nicht", "bei", "leider", "grüße", "bewerbung", "freundlichen", "uns", "zu", "zum", "zur", "ist", "haben", "möchten", "würden", "gerne", "ein", "eine", "einen", "auf", "im", "von", "wurde", "dich", "dir", "deine", "du", "liebe", "lieber", "grüezi"],
  rules: {
    received: [
      "eingangsbestätigung",
      "(haben|wir haben) (ihre|deine) (bewerbung|bewerbungsunterlagen|unterlagen) (erhalten|bekommen)",
      "(ihre|deine) bewerbung (ist|wurde) (bei uns )?(eingegangen|erfolgreich übermittelt|übermittelt)",
      "bestätigen (wir )?den eingang",
      "eingang (ihrer|deiner) bewerbung",
    ],
    rejection: [
      "(für|zugunsten) (einen |eine )?(anderen|andere|einer anderen) (kandidat|bewerber)\\p{L}*",
      "(nicht|keine) (weiter )?berücksichtig\\p{L}*",
      "nicht (in die engere auswahl|weiter verfolgen|weiterverfolgen)",
      "absage",
      "(stelle|position)[^.]{0,60}? (ist|wurde) (bereits |inzwischen |leider )?(besetzt|vergeben|gestrichen)",
      "keine zusage",
      // WO-050: the post will not be filled after all ("die Stelle wird leider nicht mehr besetzt").
      "(stelle|position)[^.]{0,60}? (wird|ist) (leider )?nicht (mehr )?besetzt",
    ],
    interview: [
      "einladung zum (vorstellungsgespräch|bewerbungsgespräch|interview|gespräch|kennenlerngespräch)",
      "(vorstellungsgespräch|bewerbungsgespräch|interview|kennenlerngespräch)[^.]{0,60}(einladen|einzuladen)",
      "(vorstellungsgespräch|bewerbungsgespräch|interview) (ist )?(bestätigt|vereinbart)",
      "termin für das (vorstellungsgespräch|bewerbungsgespräch|interview|gespräch)",
      "(zweites|erstes) (interview|gespräch)",
      // WO-050: moved ("wir müssen Ihr Vorstellungsgespräch ... verschieben", "neuer Termin für Ihr Vorstellungsgespräch").
      "(vorstellungsgespräch|bewerbungsgespräch|interview|gespräch)[^.]{0,60}(verschieben|verlegen|verschoben|verlegt)",
      "neuer termin für (ihr|dein) (vorstellungsgespräch|bewerbungsgespräch|interview|gespräch)",
    ],
    assessment: ["online-?test", "online-?assessment", "einstufungstest|eignungstest", "fallstudie", "case study", "probeaufgabe|testaufgabe|probearbeit"],
    offer: ["vertragsangebot", "arbeitsvertrag", "(stelle|position)[^.]{0,40}anbieten (zu können|möchten)", "anbieten zu können", "zusage für (die|eine) (stelle|position)"],
  },
  families: {
    "rc:got": [
      "(haben|wir haben) (ihre|deine|sie) (bewerbung |unterlagen |bewerbungsunterlagen )?(erhalten|bekommen)",
      "(bewerbung|unterlagen)[^.]{0,40}? (ist|sind|wurde|wurden) (bei uns )?(eingegangen|erfolgreich übermittelt|übermittelt|angekommen)",
      "eingang (ihrer|deiner) bewerbung",
      "eingangsbestätigung",
    ],
    "rc:thanks": ["(vielen )?dank für (ihre|deine) (bewerbung|interesse)", "danke für (ihre|deine) bewerbung", "bedanken uns für (ihre|ihr|deine|dein) (bewerbung|interesse)"],
    "rc:review": ["prüfen (ihre|deine|diese|sie)", "(wird|werden) (sorgfältig )?geprüft", "melden uns (in kürze|zeitnah|bald|so schnell wie möglich|bei ihnen|bei dir)", "schauen sie uns", "den status können sie"],
    "rj:other_candidate": ["(für|zugunsten) (einen |eine )?(anderen|andere|einer anderen) (kandidat|bewerber|interessent)\\p{L}*"],
    "rj:closed": ["(stelle|position)[^.]{0,60}? (ist|wurde|wurden) (bereits |inzwischen |leider )?(besetzt|vergeben|gestrichen|geschlossen)"],
    "rj:pass": ["nicht (in die engere auswahl|weiter berücksichtig|berücksichtig)\\p{L}*", "absage", "passt[^.]{0,30} nicht"],
    "rj:regret": ["leider", "bedauer\\p{L}*"],
    "rj:closer": ["(wünschen|wünsche) (ihnen|dir)[^.]{0,40}(erfolg|alles gute|glück)", "viel erfolg", "alles gute"],
    "rj:future": ["in evidenz", "talentpool|bewerberpool", "zukünftige (stellen|positionen|möglichkeiten)", "behalten (ihre|deine) unterlagen"],
    "rj:decision": ["nach (sorgfältiger|reiflicher|langer|eingehender) (prüfung|überlegung|abwägung)", "dieses mal", "schwere entscheidung"],
    "iv:noun": ["vorstellungsgespräch\\p{L}*", "bewerbungsgespräch\\p{L}*", "interviews?", "kennenlerngespräch\\p{L}*", "telefoninterview"],
    "iv:talk": ["gespräch\\p{L}*", "telefonat", "videocall", "kennenlernen", "kennenzulernen", "treffen"],
    "iv:invite": [
      "(möchten|würden|würde|wollen) (sie|dich) (gerne |gern )?(zu [^.]{0,40})?(einladen|kennenlernen|treffen)",
      "(freuen uns|freue mich),? (sie|dich) [^.]{0,40}(einzuladen|kennenzulernen)",
      "einladung zu",
      "laden (wir )?(sie|dich) [^.]{0,40}ein",
      "die nächste runde",
    ],
    "iv:schedule": ["termin\\p{L}*", "(wählen|buchen|aussuchen|vereinbaren) sie", "einen (passenden )?termin", "verfügbarkeit", "zeitslot", "passt (ihnen|dir)"],
    "iv:when": ["montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag", "\\d{1,2}[:.]\\d\\d uhr", "\\d{1,2} uhr"],
    "iv:who": ["mit (dem|der) (teamleiter\\p{L}*|abteilungsleiter\\p{L}*|fachabteilung|geschäftsführ\\p{L}*|hiring manager)", "gesprächspartner\\p{L}*"],
    "as:noun": ["tests?", "online-?test", "online-?assessment", "assessment", "aufgabe", "fallstudie", "case study", "eignungstest"],
    "as:do": ["absolvieren", "bearbeite\\p{L}*", "durchführen", "lösen", "ablegen"],
    "as:deadline": ["bis (zum|spätestens) \\d", "bis (montag|dienstag|mittwoch|donnerstag|freitag)", "innerhalb (von )?\\d+ (stunden|tagen)", "frist"],
    "x:minutes": ["\\d+ ?(minuten|min)", "\\d+-minütig\\p{L}*"],
    "x:next_step": ["nächsten schritt", "nächste schritt"],
    "of:noun": ["vertragsangebot", "arbeitsvertrag", "angebot (für|als)", "(unser|ihr|dein) angebot"],
    "of:extend": ["(stelle|position)[^.]{0,40}anbieten", "anbieten zu können", "im team haben", "an bord haben"],
    "of:joy": ["herzlichen glückwunsch", "gratulieren", "willkommen (im team|an bord)"],
    "of:sign": ["unterschrift", "unterschreiben", "unterschrieben\\p{L}*", "gehalt", "vergütung", "startdatum", "eintrittsdatum"],
    "rr:status": [
      "noch (mitten )?(im|in der|in) (auswahlprozess|prozess|bewerbungsprozess|abstimmung|auswahl)",
      "noch keine (entscheidung|rückmeldung)",
      "melde mich,? (sobald|wenn)",
      "(könnten|können) sie (mir )?(bitte )?(noch )?(ihre|uns)",
      "gehaltsvorstellung",
      "frühestmöglich\\p{L}*",
    ],
  },
  negators: ["nicht", "kein\\p{L}*", "nie"],
  progress: ["berücksichtig\\p{L}*", "weiter\\p{L}*", "fortsetzen", "fortfahren", "anbieten", "zusage\\p{L}*", "einladen", "einzuladen", "ausgewählt", "engere auswahl", "passt", "passen", "entspricht", "entsprechen", "in betracht", "verfolgen"],
  noDecision: ["^\\s*(falls|wenn|sofern|sollten (sie|du))", "zögern sie nicht", "nicht (auf diese e-mail )?antworten", "bewerber\\p{L}*,? die nicht"],
  past: ["(vielen )?dank (nochmal |noch einmal )?für (das|deine|ihre|ihr) (nette |angenehme |freundliche |gute )?(gespräch|zeit|interview)[^.]*"],
  maybe: ["(falls|wenn|sollten) (sie|du|ihre bewerbung|ihr profil|dein profil) [^.]{0,40}(überzeug|ausgewählt|engere auswahl|eingeladen|passt)[^.]*"],
  job: ["bewerb\\p{L}*", "stelle", "position", "vorstellungsgespräch", "auswahlprozess", "lebenslauf", "unterlagen", "recruiting", "ausbildung", "praktikum", "werkstudent\\p{L}*", "trainee\\p{L}*", "kandidat\\p{L}*", "job-id"],
  noiseSubject: ["neue jobs", "jobangebote", "stellenangebote", "jobagent", "jobalarm", "newsletter", "umfrage", "wie war dein", "webinar", "karrieremesse", "jobmesse", "viel glück"],
  noiseText: ["vorstellungsgespräch (üben|training)", "tipps für", "abmelden", "drücke dir"],
  notJob: ["wohnung\\p{L}*", "vermieter", "mietbewerbung", "kreditkarte", "kreditantrag", "antrag auf (eine |einen )?(kredit|kreditkarte|konto)", "kontoeröffnung"],
  recruiter: ["(ihre|deine) (bewerbung|unterlagen|nachfrage)"],
};

const IT: LangWords = {
  marks: ["ciao", "gentile", "grazie", "il", "della", "di", "che", "per", "siamo", "tua", "tuo", "suo", "non", "cordiali", "saluti", "colloquio", "ti", "ci", "dei", "nel", "nella", "alla", "alle", "sono", "è", "abbiamo", "purtroppo", "lieti", "posizione", "selezione", "buongiorno", "hai", "sei", "stato", "stata", "gli"],
  rules: {
    received: [
      "abbiamo ricevuto (la tua|la sua|il tuo|il suo) (candidatura|cv|curriculum)",
      "(la tua|la sua) candidatura[^.]{0,60}? (è stata )?(ricevuta|registrata|arrivata)",
      "conferma (di )?ricezione",
      "aver ricevuto la (tua|sua) candidatura",
    ],
    rejection: [
      "non (sei stat[oa]|è stat[oa]|siete stati) (selezionat|scelt|ritenut)\\p{L}*",
      "non è stat[oa] ritenut[oa] in linea",
      "(deciso|scelto) di (proseguire|procedere|continuare) con altr[ie] (candidat|profil)\\p{L}*",
      "non (possiamo|potremo|potremmo|andremo) (procedere|proseguire|andare avanti|dare seguito)",
      "(posizione|ricerca)[^.]{0,40}? (è stata|è) (chiusa|coperta|sospesa|annullata)",
    ],
    interview: [
      "invito (a|al|per un) colloquio",
      "(convocazione|convocarti|convocarla) (a|al|per)( un)? colloquio",
      "colloquio (confermato|fissato|programmato)",
      "(siamo lieti|vorremmo|ci piacerebbe) (di )?(invitarti|invitarla)[^.]{0,30}colloquio",
      "(secondo|primo) colloquio",
      "selezionat[oa] per (il |un )?colloquio",
      // WO-050: moved or confirmed ("dobbiamo spostare il tuo colloquio", "ti confermiamo il colloquio").
      "(spostare|rinviare|posticipare|spostato|rinviato) (il tuo |il suo |il )?colloquio",
      "spostamento (del )?colloquio",
      "(ti |le )?confermiamo il (tuo |suo )?colloquio",
    ],
    assessment: ["test (online|tecnico|attitudinale|di logica)", "prova (tecnica|scritta|online|pratica)", "caso studio", "esercizio (tecnico|di design|pratico)"],
    offer: ["lettera di offerta", "proposta (di assunzione|contrattuale)", "(siamo lieti|abbiamo il piacere) di (offrirti|offrirle|proporti|proporle)"],
  },
  families: {
    "rc:got": ["(abbiamo|aver) ricevuto (la tua|la sua|il tuo|il suo)", "candidatura[^.]{0,60}? (è stata )?(ricevuta|registrata|arrivata)", "conferm\\p{L}* (di aver ricevuto|la ricezione|ricezione)"],
    "rc:thanks": ["grazie (per|della) (la tua|la sua|tua|sua) candidatura", "grazie per (esserti|essersi) candidat\\p{L}*", "grazie per (il tuo|il suo) interesse"],
    "rc:review": ["valuteremo|valuterà|esamineremo|leggerà", "sarà (valutata|esaminata)", "in fase di valutazione", "ti faremo sapere", "sarà ricontattat\\p{L}*"],
    "rj:other_candidate": ["(proseguire|procedere|continuare|scelto|optato)[^.]{0,30}? con altr[ie] (candidat|profil)\\p{L}*"],
    "rj:closed": ["(posizione|ricerca)[^.]{0,60}? (è stata|è) (chiusa|coperta|sospesa|annullata)"],
    "rj:pass": ["non (è stata|sei stato|sei stata|è stato) (selezionat|ritenut|accolt)\\p{L}*", "non andremo avanti"],
    "rj:regret": ["purtroppo", "siamo spiacenti", "ci dispiace", "rammarico"],
    "rj:closer": ["(ti|le|vi) auguriamo[^.]{0,30}(meglio|fortuna|successo)", "in bocca al lupo", "buona fortuna"],
    "rj:future": ["conserveremo (il tuo|il suo) (cv|curriculum)", "future (opportunità|posizioni|selezioni)", "database"],
    "rj:decision": ["dopo (un'attenta|attenta|un'accurata) valutazione", "a seguito delle valutazioni", "questa volta"],
    "iv:noun": ["colloqui|colloquio", "intervista"],
    "iv:talk": ["call", "chiamata", "videochiamata", "incontro", "chiacchier\\p{L}*", "conoscerti", "conoscerla"],
    "iv:invite": [
      "(siamo lieti|vorremmo|ci piacerebbe) (di )?(invitarti|invitarla|conoscerti|conoscerla)",
      "(ti|la) (invitiamo|proponiamo)",
      "invito a",
      "(hai|ha) superato (il primo|la prima)",
      "(è stato|sei stato|è stata|sei stata) selezionat\\p{L}* per",
      "vorrei fissare",
    ],
    "iv:schedule": ["(scegli|seleziona|prenota|fissare|fissiamo|programmare)[^.]{0,20}(orario|data|slot|fascia|colloquio|call)", "disponibilità", "slot disponibili", "confermare la presenza"],
    "iv:when": ["lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica", "alle (ore )?\\d{1,2}"],
    "iv:who": ["con (il|la) (responsabile|manager|store manager|direttore|direttrice)"],
    "as:noun": ["test", "prova", "esercizio", "caso studio", "questionario"],
    "as:do": ["completarlo|completarla|svolgerlo|svolgerla", "(completare|svolgere|sostenere|risolvere) (il |la |un |una |un piccolo )?(test|prova|esercizio|caso)"],
    "as:deadline": ["(hai|ha|avete) \\d+ (ore|giorni)", "entro (il |\\d|lunedì|martedì|mercoledì|giovedì|venerdì)", "scadenza"],
    "x:minutes": ["\\d+ ?(minuti|min)"],
    "x:next_step": ["prossimo (step|passo)", "prossima fase"],
    "of:noun": ["lettera di offerta", "proposta (di assunzione|contrattuale)", "contratto di lavoro", "(la nostra|la tua) offerta"],
    "of:extend": ["(offrirti|offrirle|proporti|proporle) (la posizione|il ruolo|un contratto)", "vorremmo averti con noi"],
    "of:joy": ["congratulazioni", "è ufficiale", "benvenut[oa] (nel team|a bordo)"],
    "of:sign": ["firmare", "firma", "retribuzione", "ral", "data di inizio", "benefit"],
    "rr:status": ["(ancora|tuttora) in corso", "non ha ancora deciso", "ti farò sapere", "(potresti|potrebbe) (inviarmi|mandarmi|indicarmi)", "ral attuale", "aspettative economiche", "lo giro al"],
  },
  negators: ["non"],
  progress: ["selezionat\\p{L}*", "ritenut\\p{L}*", "procedere", "proseguire", "andare avanti", "andremo avanti", "dare seguito", "accolt\\p{L}*", "in linea", "idone\\p{L}*", "scelt\\p{L}*", "invitar\\p{L}*", "offrir\\p{L}*"],
  noDecision: ["^\\s*(se|qualora|nel caso)", "non (esitare|esiti|rispondere)", "candidati che non"],
  past: ["grazie (ancora )?per (il colloquio|la disponibilità|aver partecipato|il tempo dedicato|la chiacchierata)[^.]*"],
  maybe: ["(qualora|se) (il (tuo|suo) profilo|la (tua|sua) candidatura|sarai|venissi|dovessi essere)[^.]*"],
  job: ["candidat\\p{L}*", "posizione", "colloqui\\p{L}*", "selezione", "curriculum", "cv", "stage", "tirocinio", "assunzione"],
  noiseSubject: ["offerte di lavoro", "nuove offerte", "com'è andato", "newsletter", "sondaggio", "webinar"],
  noiseText: ["simulazione di colloquio", "consigli per il colloquio", "annulla l'iscrizione", "disiscriviti", "in forma anonima"],
  notJob: ["mutuo", "prestito", "carta di credito", "conto corrente", "ammission\\p{L}*", "laurea"],
  recruiter: ["(la tua|la sua) candidatura", "(il tuo|il suo) (cv|curriculum|messaggio)"],
};

const NL: LangWords = {
  marks: ["hoi", "beste", "bedankt", "je", "jouw", "uw", "wij", "het", "een", "van", "voor", "met", "niet", "helaas", "groet", "groeten", "sollicitatie", "vacature", "graag", "dat", "ons", "onze", "naar", "bij", "zijn", "hebben", "wordt", "kunnen", "ook", "heb", "jij", "leuk", "nogmaals"],
  rules: {
    received: [
      "(we hebben|wij hebben) (je|jouw|uw) (sollicitatie|cv|kandidatuur)[^.]{0,30}? ontvangen",
      "ontvangstbevestiging",
      "(bevestigen|bevestiging van) (de ontvangst|je sollicitatie|uw sollicitatie)",
      "(je|uw) sollicitatie is (in goede orde |goed )?(ontvangen|binnen|aangekomen)",
    ],
    rejection: [
      "niet (verder )?(gaan|door) met (je|jouw|uw) (sollicitatie|kandidatuur)",
      "(gekozen|besloten) (voor|om) (een )?andere (kandidaat|kandidaten|sollicitant)",
      "(besloten|helaas)[^.]{0,40}niet (uit te nodigen|verder te gaan|door te gaan)",
      "nodigen (we|wij) (je|u) (helaas )?niet uit",
      "vacature[^.]{0,40}? (is )?(inmiddels )?(ingevuld|vervuld|gesloten|ingetrokken)",
      "niet (verder )?in behandeling nemen",
      "afwijzing",
    ],
    interview: [
      "uitnodiging (voor|tot) (een |het )?(sollicitatiegesprek|gesprek|kennismakingsgesprek|interview)",
      "(uitnodigen|uit te nodigen|nodigen [^.]{0,15}uit) voor (een |het )?(eerste |tweede )?(sollicitatie)?gesprek",
      "(tweede|eerste) gesprek",
      "gesprek[^.]{0,30}(staat gepland|is gepland|bevestigd)",
      "door naar de (tweede|volgende) ronde",
      // WO-050: moved ("we moeten je gesprek ... verplaatsen", "nieuwe tijd voor je gesprek").
      "(sollicitatie)?gesprek[^.]{0,60}(verplaatsen|verzetten|verplaatst|verzet)",
      "nieuwe (tijd|datum) voor (je|uw) (sollicitatie)?gesprek",
    ],
    assessment: ["online (test|assessment)", "capaciteitentest", "persoonlijkheids(test|vragenlijst)", "case-?opdracht", "praktijkopdracht", "casusopdracht"],
    // WO-050: "we willen je graag de functie van Backend Engineer aanbieden".
    offer: ["arbeidsovereenkomst", "contractvoorstel", "aanbodsbrief", "(bieden|bied) (je|u) [^.]{0,40}aan", "(willen|wil) (je|u) [^.]{0,60}aanbieden"],
  },
  families: {
    "rc:got": ["(sollicitatie|cv|motivatie|kandidatuur)[^.]{0,40}? (in goede orde )?ontvangen", "(bevestigen|bevestiging van) de ontvangst", "(sollicitatie|kandidatuur) is (goed |in goede orde )?(binnen|aangekomen|ontvangen)", "ontvangstbevestiging"],
    "rc:thanks": ["bedankt voor (je|jouw|uw) (sollicitatie|interesse|kandidatuur)", "(leuk|fijn) dat je (solliciteert|hebt gesolliciteerd)", "dank (je )?voor (je|uw) sollicitatie"],
    "rc:review": ["(bekijken|beoordelen) (je|uw|jouw|deze|het)", "kijken er (snel )?naar", "nemen [^.]{0,30}contact (met je|met u) op", "laten [^.]{0,30}van ons horen", "zo snel mogelijk"],
    "rj:other_candidate": ["(gekozen|besloten|gaan verder) (voor|met) (een )?andere (kandidaat|kandidaten|sollicitant)\\p{L}*"],
    "rj:closed": ["vacature[^.]{0,40}? (is )?(inmiddels )?(ingevuld|vervuld|gesloten|ingetrokken|vervallen)"],
    "rj:pass": ["niet (geselecteerd|uitgenodigd)", "niet verder", "past[^.]{0,30} niet", "afwijzing"],
    "rj:regret": ["helaas", "tot onze spijt", "het spijt (ons|me)", "jammer genoeg"],
    "rj:closer": ["(wens|wensen) (je|u)[^.]{0,30}(succes|het beste)", "veel succes"],
    "rj:future": ["toekomstige (vacatures|mogelijkheden|functies)", "talentpool", "(bewaren|houden) (je|uw) (cv|gegevens)"],
    "rj:decision": ["na (zorgvuldige|grondige) (overweging|afweging|beoordeling)", "na beoordeling", "deze keer"],
    "iv:noun": ["sollicitatiegesprek\\p{L}*", "kennismakingsgesprek\\p{L}*", "interviews?", "(eerste|tweede|volgende) gesprek"],
    "iv:talk": ["gesprek\\p{L}*", "kennismaken", "kennismaking", "videogesprek", "belafspraak", "afspraak"],
    "iv:invite": ["(willen|wil) (je|u) (graag )?(uitnodigen|leren kennen)", "nodigen (je|u|wij u|we je) (graag )?uit", "uitnodiging (voor|tot)", "door naar de (tweede|volgende) ronde", "heb je zin om"],
    "iv:schedule": ["(kies|plan|selecteer|inplannen|plannen|te plannen)[^.]{0,30}(moment|tijdstip|datum|gesprek)", "beschikbaarheid", "(welke dagen|wanneer) je kunt", "(dat|die) jou uitkomt", "staat gepland", "(komst|aanwezigheid) te bevestigen"],
    "iv:when": ["maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag", "om \\d{1,2}([:.]\\d\\d)? ?(uur|u)", "\\d{1,2}:\\d\\d uur"],
    "iv:who": ["met (de|het) (manager|teamleider|hiring manager)"],
    "as:noun": ["test", "assessment", "opdracht", "case-?opdracht", "casus", "vragenlijst", "capaciteitentest"],
    "as:do": ["rond[^.]{0,20}af", "lever[^.]{0,30}in", "afronden", "invullen"],
    "as:deadline": ["binnen \\d+ (dagen|uur|werkdagen)", "uiterlijk", "deadline"],
    "x:minutes": ["\\d+ ?(minuten|min)"],
    "x:next_step": ["volgende stap", "volgende ronde"],
    "of:noun": ["arbeidsovereenkomst", "contractvoorstel", "aanbodsbrief", "(je|jouw|ons) contract", "(ons|het|een|je) aanbod"],
    "of:extend": ["(bieden|bied) (je|u) [^.]{0,40}aan", "aan boord", "aanbieden"],
    "of:joy": ["gefeliciteerd", "proficiat", "welkom (bij|aan boord)"],
    "of:sign": ["tekenen", "ondertekenen", "teken", "handtekening", "salaris", "startdatum"],
    "rr:status": [
      "(nog|nog steeds) (midden )?in (de )?(selectieprocedure|procedure|behandeling)",
      "zitten nog midden in",
      "laat (ik|we) (je|u) [^.]{0,30}weten",
      "(kun|kan|kunt) (je|u) (mij|me|ons) [^.]{0,40}(sturen|toesturen|mailen)",
      "salarisindicatie|salariswens",
      "nog geen (beslissing|terugkoppeling)",
    ],
  },
  negators: ["niet", "geen", "nooit"],
  progress: ["verder\\p{L}*", "door", "uit te nodigen", "uitnodigen", "uit", "geselecteerd", "in behandeling", "aanbieden", "past", "passen", "aansluit\\p{L}*", "door te gaan"],
  noDecision: ["^\\s*(als|indien|mocht|tenzij|wanneer)", "niet (te )?beantwoorden", "aarzel niet", "kandidaten die niet"],
  past: ["(nogmaals |alvast )?bedankt voor (het|je|jouw) (fijne |prettige |leuke )?(gesprek|tijd|interview)[^.]*"],
  maybe: ["(als|indien|mocht) (je|u|jouw|uw) [^.]{0,40}(geselecteerd|uitgenodigd)[^.]*"],
  job: ["sollicit\\p{L}*", "vacatures?", "functie", "kandidat\\p{L}*", "kandidaat", "cv", "werving", "selectie\\p{L}*", "gesprek", "traineeship", "stage"],
  noiseSubject: ["nieuwe vacatures", "vacatures voor jou", "nieuwsbrief", "enquête", "webinar", "zo bereid je je voor"],
  noiseText: ["oefengesprek", "tips voor (je )?sollicitatie", "afmelden", "uitschrijven", "in deze nieuwsbrief"],
  notJob: ["huuraanvraag", "woning", "verhuurder", "creditcard", "lening", "hypotheek"],
  recruiter: ["(je|jouw|uw) (sollicitatie|cv|bericht|kandidatuur)"],
};

export const LANG_WORDS: Record<Lang, LangWords> = { es: ES, pt: PT, fr: FR, de: DE, it: IT, nl: NL };

// ------------------------------------------------------------------------------------------------ compiled
// A word edge that knows accented letters: (?<![\p{L}\p{N}]) ... (?![\p{L}\p{N}]).
const L = String.raw`(?<![\p{L}\p{N}])`, R = String.raw`(?![\p{L}\p{N}])`;
const anyOf = (list: string[], flags = "iu") => new RegExp(`${L}(?:${list.join("|")})${R}`, flags);
export interface LangReader {
  lang: Lang;
  rules: [Kind, RegExp][];
  families: [string, RegExp][];
  negated: RegExp;
  noDecision: RegExp;
  past: RegExp;
  maybe: RegExp;
  job: RegExp;
  noiseSubject: RegExp;
  noiseText: RegExp;
  notJob: RegExp;
  recruiter: RegExp;
}
function compile(lang: Lang, w: LangWords): LangReader {
  return {
    lang,
    rules: (Object.entries(w.rules) as [Kind, string[]][]).map(([k, list]) => [k, anyOf(list)]),
    families: Object.entries(w.families).map(([name, list]) => [name, anyOf(list)]),
    negated: new RegExp(`${L}(?:${w.negators.join("|")})(?:\\s+\\S+){0,5}?\\s+(?:${w.progress.join("|")})${R}`, "iu"),
    noDecision: new RegExp(`(?:${w.noDecision.map((p) => (p.startsWith("^") ? `${p}${R}` : `${L}(?:${p})${R}`)).join("|")})`, "iu"),
    past: anyOf(w.past, "giu"),
    maybe: anyOf(w.maybe, "giu"),
    job: anyOf(w.job),
    noiseSubject: anyOf(w.noiseSubject),
    noiseText: anyOf(w.noiseText),
    notJob: anyOf(w.notJob),
    recruiter: anyOf(w.recruiter),
  };
}
export const LANG_READERS: Record<Lang, LangReader> = Object.fromEntries((Object.entries(LANG_WORDS) as [Lang, LangWords][]).map(([k, w]) => [k, compile(k, w)])) as Record<Lang, LangReader>;

// The language a message is read in besides English: the one with the most of its marks among the words, when it has at
// least three and more than English has (two are enough in a short message with no English marks). null: English only.
const EN_MARKS = new Set(["the", "you", "your", "we", "and", "to", "for", "our", "with", "thank", "thanks", "is", "are", "please", "hi", "dear", "regards", "of", "in", "this", "that", "will", "have", "be", "an", "on", "at", "it", "us", "would", "best"]);
const MARKS = Object.fromEntries((Object.entries(LANG_WORDS) as [Lang, LangWords][]).map(([k, w]) => [k, new Set(w.marks)])) as Record<Lang, Set<string>>;
export function langOf(normalized: string): Lang | null {
  const words = normalized.match(/\p{L}+/gu) ?? [];
  const en = words.filter((w) => EN_MARKS.has(w)).length;
  let best: Lang | null = null, top = 0;
  for (const lang of Object.keys(MARKS) as Lang[]) {
    const n = words.filter((w) => MARKS[lang].has(w)).length;
    if (n > top) { top = n; best = lang; }
  }
  return (top >= 3 && top > en) || (top >= 2 && en === 0) ? best : null;
}
