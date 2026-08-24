import nodemailer from 'nodemailer';

function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function llm(prompt) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-lite-preview-02-05:free';
  
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'http://localhost:5000',
        'X-Title': 'CareFlow'
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are a safe healthcare appointment assistant. Never diagnose. Always respond with raw valid JSON exactly as instructed, without any markdown formatting.'
          },
          { role: 'user', content: prompt }
        ]
      })
    });
    
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? null;
    return text ? stripFences(text) : null;
  } catch (e) {
    console.error(`[LLM] ❌ OpenRouter failed: ${e.message}`);
    return null;
  }
}

export async function generatePreVisitSummary(symptoms) {
  const t = String(symptoms || '').trim();
  const l = t.toLowerCase();

  const highKeywords = ['severe chest pain', 'difficulty breathing', 'fainting', 'unconscious', 'heavy bleeding'];
  const medKeywords  = ['high fever', 'persistent vomiting', 'severe pain', 'dizziness'];
  const urgency = highKeywords.some(k => l.includes(k)) ? 'High'
                : medKeywords.some(k => l.includes(k))  ? 'Medium'
                : 'Low';

  const fallback = {
    urgency,
    summary: `Chief complaint: ${(t.split(/[.!?]/)[0] || 'No symptoms provided').slice(0, 180)}. Screening summary, not a diagnosis.`,
    questions: [
      'When did the symptoms start and how have they changed?',
      'Are there any triggers, current medications, allergies, or previous conditions?',
      'What is the most concerning symptom for the patient right now?'
    ]
  };

  const raw = await llm(
    `Analyse the following patient symptoms and return a JSON object with exactly these three fields:\n` +
    `- "urgency": one of "Low", "Medium", or "High"\n` +
    `- "chiefComplaint": a concise one-sentence summary of the main complaint\n` +
    `- "suggestedQuestions": an array of exactly 3 clarifying questions the doctor should ask\n` +
    `Do not diagnose. Symptoms: ${t || 'None provided'}`
  );

  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw);
    return {
      urgency:   ['Low', 'Medium', 'High'].includes(p.urgency) ? p.urgency : urgency,
      summary:   `Chief complaint: ${String(p.chiefComplaint || fallback.summary).slice(0, 350)}. Screening summary, not a diagnosis.`,
      questions: Array.isArray(p.suggestedQuestions) ? p.suggestedQuestions.slice(0, 3) : fallback.questions
    };
  } catch {
    return fallback;
  }
}

export async function generatePostVisitSummary(notes, prescription) {
  const fallback = {
    summary:            `Visit summary: ${String(notes || '').trim() || 'No additional notes recorded.'} Follow the clinician's instructions and contact the clinic if symptoms worsen.`,
    medicationSchedule: String(prescription || '').trim() || 'No medication schedule recorded.',
    followUp:           "Follow the doctor's recommended follow-up plan."
  };

  const raw = await llm(
    `Convert the following clinical notes into a patient-friendly summary.\n` +
    `Return a JSON object with exactly these three fields:\n` +
    `- "summary": plain-language summary of the visit\n` +
    `- "medicationSchedule": medication instructions in simple terms\n` +
    `- "followUp": the recommended follow-up action\n` +
    `Do not diagnose.\nNotes: ${notes || 'None'}\nPrescription: ${prescription || 'None'}`
  );

  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw);
    return {
      summary:            String(p.summary            || fallback.summary),
      medicationSchedule: String(p.medicationSchedule || fallback.medicationSchedule),
      followUp:           String(p.followUp            || fallback.followUp)
    };
  } catch {
    return fallback;
  }
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.resend.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'resend',
    pass: process.env.SMTP_PASS
  }
});

export async function sendEmail({ to, subject, text }) {
  if (!process.env.SMTP_PASS) {
    console.log(`[EMAIL MOCK] To: ${to} | Subject: ${subject}`);
    return { delivered: true };
  }
  
  const displaySubject = subject.startsWith('CareFlow') ? subject : `CareFlow: ${subject}`;
  const title = subject.replace('CareFlow: ', '').replace('CareFlow — ', '');

  const html = `
    <div style="background-color: #fbf9f9; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px 20px; color: #334155; line-height: 1.6;">
      <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02); border: 1px solid #f1f5f9;">
        <div style="padding: 28px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
          <div style="font-weight: 600; font-size: 22px; color: #0f172a; margin: 0;">
            <span style="color: #f5a9c5; font-size: 26px; margin-right: 8px; vertical-align: middle;">✚</span><span style="vertical-align: middle;">CareFlow</span>
          </div>
        </div>
        <div style="padding: 32px;">
          <h2 style="margin-top: 0; margin-bottom: 16px; font-size: 20px; color: #0f172a; font-weight: 600;">${title}</h2>
          <div style="white-space: pre-wrap; font-size: 15px;">${text.replace(/\n\n/g, '<br><br>')}</div>
        </div>
        <div style="padding: 24px 32px; background: #f8fafc; font-size: 13px; color: #64748b; text-align: center; border-top: 1px solid #f1f5f9;">
          Compassionate care, simplified.<br>
          <span style="opacity: 0.8;">This is an automated message from your CareFlow workspace.</span>
        </div>
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || 'CareFlow <noreply@careflow.local>',
      to,
      subject: displaySubject,
      text,
      html
    });
    return { delivered: true, messageId: info.messageId };
  } catch (error) {
    throw new Error(`SMTP Error: ${error.message}`);
  }
}

function googleReady() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function getGoogleAuthUrl() {
  if (!googleReady()) return null;
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/calendar/oauth/callback',
    response_type: 'code',
    access_type:   'offline',
    prompt:        'consent',
    scope:         'https://www.googleapis.com/auth/calendar.events'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/calendar/oauth/callback',
      grant_type:    'authorization_code'
    })
  });
  if (!r.ok) throw new Error(`Google OAuth ${r.status}: ${await r.text()}`);
  return r.json();
}

async function getGoogleAccessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  if (!process.env.GOOGLE_REFRESH_TOKEN || !googleReady()) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  if (!r.ok) throw new Error(`Google token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}

export async function createCalendarEvent(appt) {
  const tok = await getGoogleAccessToken();
  if (!tok) {
    console.log(`[CALENDAR FALLBACK] Appointment #${appt.id} on ${appt.appointment_date} at ${appt.start_time}`);
    return { created: false };
  }
  const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary:     `CareFlow • ${appt.doctor_name}`,
        description: `Patient: ${appt.patient_name || 'Patient'}\nAppointment #${appt.id}`,
        start: { dateTime: `${appt.appointment_date}T${appt.start_time}:00`, timeZone: 'Asia/Kolkata' },
        end:   { dateTime: `${appt.appointment_date}T${appt.end_time}:00`,   timeZone: 'Asia/Kolkata' }
      })
    }
  );
  if (!r.ok) throw new Error(`Calendar create failed: ${r.status} ${await r.text()}`);
  return { created: true, eventId: (await r.json()).id };
}

export async function deleteCalendarEvent(eventId) {
  const tok = await getGoogleAccessToken();
  if (!tok || !eventId) return { deleted: false };
  const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!r.ok && r.status !== 404) throw new Error(`Calendar delete failed: ${r.status}`);
  return { deleted: true };
}

function parseIntervalHours(schedule) {
  const s = String(schedule || '').toLowerCase();
  const everyHours = s.match(/every\s+(\d+)\s+hours?/);
  if (everyHours) return Number(everyHours[1]);
  if (/\b(4\s*times|four\s+times|4x|qid)\b/.test(s))      return 6;
  if (/\b(3\s*times|three\s+times|3x|tid)\b/.test(s))      return 8;
  if (/\b(twice|2\s*times|two\s+times|2x|bid)\b/.test(s))  return 12;
  if (/\b(once|1\s*time|one\s+time|1x|qd|daily)\b/.test(s)) return 24;
  return 24;
}

import { Reminder, Notification } from './db.js';

export async function processDueReminders() {
  const due = await Reminder.find({
    status: 'active',
    next_run: { $lte: new Date() }
  }).populate('patient_id', 'name email').limit(20);

  for (const reminder of due) {
    if (!reminder.patient_id) continue;
    try {
      await sendEmail({
        to:      reminder.patient_id.email,
        subject: 'CareFlow — Medication Reminder',
        text:    `Hi ${reminder.patient_id.name},\n\nThis is your medication reminder:\n${reminder.schedule}\n\nStay healthy!\n— CareFlow`
      });
      const hours = parseIntervalHours(reminder.schedule);
      const nextRun = new Date();
      nextRun.setHours(nextRun.getHours() + hours);
      
      reminder.next_run = nextRun;
      await reminder.save();
    } catch (e) {
      reminder.status = 'error';
      await reminder.save();
      console.error('Reminder error for', reminder.patient_id.email, ':', e.message);
    }
  }
}
