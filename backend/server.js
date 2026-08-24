import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDB, User, DoctorProfile, Leave, Appointment, Notification } from './db.js';
import {
  generatePreVisitSummary, generatePostVisitSummary,
  sendEmail, createCalendarEvent, deleteCalendarEvent,
  getGoogleAuthUrl, exchangeGoogleCode, processDueReminders
} from './services.js';

const app = express();
const PORT = Number(process.env.PORT || 5000);
const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Connect DB (handles Vercel cold starts)
connectDB();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ── JWT helpers ───────────────────────────────────────────────────────────────
const sign = u => jwt.sign(
  { id: u.id, role: u.role, name: u.name, email: u.email },
  SECRET,
  { expiresIn: '8h' }
);

function auth(req, res, next) {
  try {
    const t = req.headers.authorization?.replace('Bearer ', '');
    if (!t) throw 0;
    req.user = jwt.verify(t, SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Login required or session expired' });
  }
}

function role(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Access denied' });
}

// ── Notification helper ───────────────────────────────────────────────────────
async function notify(appointmentId, email, type, message) {
  const n = await Notification.create({ appointment_id: appointmentId, recipient_email: email, type, message });
  try {
    const out = await sendEmail({ to: email, subject: `CareFlow: ${type}`, text: message });
    n.status = out.delivered ? 'sent' : 'queued';
    n.attempts += 1;
    if (out.delivered) n.sent_at = new Date();
    await n.save();
  } catch (e) {
    n.status = 'failed';
    n.attempts += 1;
    n.last_error = e.message;
    await n.save();
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const u = await User.findOne({ email });
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ message: 'Invalid email or password' });
  res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ message: 'Name, email and a 6+ char password are required' });
  try {
    const u = await User.create({ name, email, password_hash: bcrypt.hashSync(password, 10), role: 'patient' });
    res.status(201).json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  } catch (e) {
    res.status(409).json({ message: 'An account with this email already exists' });
  }
});

// ── Doctors ───────────────────────────────────────────────────────────────────
app.get('/api/doctors', auth, async (req, res) => {
  const docs = await DoctorProfile.find().populate('user_id', 'name email');
  res.json(docs.map(d => ({
    id: d.id,
    name: d.user_id.name,
    email: d.user_id.email,
    specialization: d.specialization,
    bio: d.bio,
    working_start: d.working_start,
    working_end: d.working_end,
    slot_duration: d.slot_duration
  })));
});

// ── Slot generator ────────────────────────────────────────────────────────────
async function getSlots(doctorId, date) {
  const d = await DoctorProfile.findById(doctorId);
  if (!d) return [];
  const leave = await Leave.findOne({ doctor_id: doctorId, leave_date: date });
  if (leave) return [];

  const [sh, sm] = d.working_start.split(':').map(Number);
  const [eh, em] = d.working_end.split(':').map(Number);
  const out = [];

  // Clear expired holds system-wide (using createdAt and status)
  const fiveMinsAgo = new Date(Date.now() - 5 * 60000);
  await Appointment.deleteMany({ status: 'held', created_at: { $lt: fiveMinsAgo } });

  const appts = await Appointment.find({ doctor_id: doctorId, appointment_date: date, status: { $in: ['booked', 'held'] } });
  const bookedSet = new Set(appts.map(a => a.start_time));

  for (let m = sh * 60 + sm; m + d.slot_duration <= eh * 60 + em; m += d.slot_duration) {
    const startH  = String(Math.floor(m / 60)).padStart(2, '0');
    const startM  = String(m % 60).padStart(2, '0');
    const endMin  = m + d.slot_duration;
    const endH    = String(Math.floor(endMin / 60)).padStart(2, '0');
    const endMm   = String(endMin % 60).padStart(2, '0');
    const start   = `${startH}:${startM}`;
    
    out.push({ start, end: `${endH}:${endMm}`, available: !bookedSet.has(start) });
  }
  return out;
}

app.get('/api/doctors/:id/slots', auth, async (req, res) => {
  res.json(await getSlots(req.params.id, req.query.date));
});

// ── Appointments ──────────────────────────────────────────────────────────────
app.get('/api/appointments', auth, async (req, res) => {
  const q = { status: { $ne: 'held' } };
  if (req.user.role === 'patient') q.patient_id = req.user.id;
  if (req.user.role === 'doctor') {
    const dp = await DoctorProfile.findOne({ user_id: req.user.id });
    if (!dp) return res.json([]);
    q.doctor_id = dp.id;
  }

  const appts = await Appointment.find(q)
    .populate('patient_id', 'name email')
    .populate({ path: 'doctor_id', populate: { path: 'user_id', select: 'name email' } })
    .sort({ appointment_date: 1, start_time: 1 });

  res.json(appts.map(a => ({
    ...a.toJSON(),
    patient_name: a.patient_id?.name,
    patient_email: a.patient_id?.email,
    doctor_name: a.doctor_id?.user_id?.name,
    doctor_email: a.doctor_id?.user_id?.email,
    specialization: a.doctor_id?.specialization
  })));
});

// Hold an appointment slot
app.post('/api/appointments/hold', auth, role('patient'), async (req, res) => {
  const { doctorId, date, startTime } = req.body;
  try {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60000);
    await Appointment.deleteMany({ status: 'held', created_at: { $lt: fiveMinsAgo } });
    
    await Appointment.create({
      patient_id: req.user.id, doctor_id: doctorId,
      appointment_date: date, start_time: startTime, end_time: startTime,
      status: 'held'
    });
    res.json({ message: 'Slot held for 5 minutes' });
  } catch (e) {
    res.status(409).json({ message: 'This slot was just taken by someone else' });
  }
});

// Book appointment
app.post('/api/appointments', auth, role('patient'), async (req, res) => {
  const { doctorId, date, startTime, symptoms } = req.body;
  if (!doctorId || !date || !startTime) return res.status(400).json({ message: 'Doctor, date and slot required' });

  const fiveMinsAgo = new Date(Date.now() - 5 * 60000);
  await Appointment.deleteMany({ status: 'held', created_at: { $lt: fiveMinsAgo } });

  const sl = (await getSlots(doctorId, date)).find(x => x.start === startTime && x.available);
  const summary = await generatePreVisitSummary(symptoms);
  const endT = sl ? sl.end : startTime;

  let apptDoc;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const leave = await Leave.findOne({ doctor_id: doctorId, leave_date: date }).session(session);
    if (leave) throw new Error('Doctor is on leave');

    let existingHold = await Appointment.findOne({
      doctor_id: doctorId, appointment_date: date, start_time: startTime, status: 'held', patient_id: req.user.id
    }).session(session);

    if (existingHold) {
      existingHold.status = 'booked';
      existingHold.end_time = endT;
      existingHold.symptoms = symptoms || '';
      existingHold.ai_urgency = summary.urgency;
      existingHold.ai_summary = JSON.stringify(summary);
      await existingHold.save({ session });
      apptDoc = existingHold;
    } else {
      const conflict = await Appointment.findOne({
        doctor_id: doctorId, appointment_date: date, start_time: startTime, status: { $in: ['booked', 'held'] }
      }).session(session);
      if (conflict) throw new Error('That slot was just booked or is being held');
      
      const newAppt = new Appointment({
        patient_id: req.user.id, doctor_id: doctorId, appointment_date: date,
        start_time: startTime, end_time: endT, symptoms: symptoms || '',
        ai_urgency: summary.urgency, ai_summary: JSON.stringify(summary)
      });
      await newAppt.save({ session });
      apptDoc = newAppt;
    }
    await session.commitTransaction();
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(409).json({ message: e.message });
  }
  session.endSession();

  // Populate needed fields for emails
  await apptDoc.populate('patient_id', 'name email');
  await apptDoc.populate({ path: 'doctor_id', populate: { path: 'user_id', select: 'name email' } });
  
  const formattedAppt = {
    ...apptDoc.toJSON(),
    patient_name: apptDoc.patient_id.name,
    patient_email: apptDoc.patient_id.email,
    doctor_name: apptDoc.doctor_id.user_id.name,
    doctor_email: apptDoc.doctor_id.user_id.email
  };

  Promise.resolve().then(async () => {
    try {
      const c = await createCalendarEvent(formattedAppt);
      if (c.eventId) await Appointment.findByIdAndUpdate(apptDoc.id, { calendar_event_id: c.eventId });
    } catch (e) { console.error('Calendar:', e.message); }
  });

  notify(apptDoc.id, formattedAppt.patient_email, 'Booking confirmation', `Your appointment with ${formattedAppt.doctor_name} is booked for ${formattedAppt.appointment_date} at ${formattedAppt.start_time}.`);
  notify(apptDoc.id, formattedAppt.doctor_email, 'New appointment', `New appointment with ${formattedAppt.patient_name} on ${formattedAppt.appointment_date} at ${formattedAppt.start_time}.`);

  res.status(201).json(formattedAppt);
});

// Cancel appointment
app.patch('/api/appointments/:id/cancel', auth, async (req, res) => {
  const appt = await Appointment.findById(req.params.id)
    .populate('patient_id', 'name email')
    .populate({ path: 'doctor_id', populate: { path: 'user_id', select: 'name email' } });
  if (!appt) return res.status(404).json({ message: 'Appointment not found' });

  const dp = await DoctorProfile.findOne({ user_id: req.user.id });
  const allowed = req.user.role === 'admin' ||
    (req.user.role === 'patient' && appt.patient_id.id === req.user.id) ||
    (req.user.role === 'doctor' && dp?.id === appt.doctor_id.id);
  if (!allowed) return res.status(403).json({ message: 'Access denied' });

  appt.status = 'cancelled';
  appt.cancellation_reason = req.body.reason || 'Cancelled';
  await appt.save();

  if (appt.calendar_event_id) {
    try { await deleteCalendarEvent(appt.calendar_event_id); } catch (e) { console.error('Calendar:', e.message); }
  }

  notify(appt.id, appt.patient_id.email, 'Cancellation', `Your appointment on ${appt.appointment_date} at ${appt.start_time} was cancelled.`);
  notify(appt.id, appt.doctor_id.user_id.email, 'Cancellation', `Appointment with ${appt.patient_id.name} on ${appt.appointment_date} was cancelled.`);
  res.json({ message: 'Appointment cancelled' });
});

// Complete visit (doctor only)
app.post('/api/appointments/:id/visit', auth, role('doctor'), async (req, res) => {
  const appt = await Appointment.findById(req.params.id).populate('patient_id', 'email name');
  if (!appt) return res.status(404).json({ message: 'Appointment not found' });

  const myProfile = await DoctorProfile.findOne({ user_id: req.user.id });
  if (appt.doctor_id.toString() !== myProfile?.id) return res.status(403).json({ message: 'Not your appointment' });

  const { notes, prescription } = req.body;
  const summary = await generatePostVisitSummary(notes, prescription);

  appt.status = 'completed';
  appt.doctor_notes = notes || '';
  appt.prescription = prescription || '';
  appt.patient_summary = JSON.stringify(summary);
  await appt.save();

  if (prescription) {
    const { Reminder } = await import('./db.js');
    await Reminder.create({
      appointment_id: appt.id, patient_id: appt.patient_id.id,
      schedule: prescription, next_run: new Date()
    });
  }

  notify(appt.id, appt.patient_id.email, 'Visit summary', summary.summary);
  res.json({ message: 'Visit saved', summary });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/doctors', auth, role('admin'), async (req, res) => {
  const { name, email, password, specialization, workingStart, workingEnd, slotDuration, bio } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const u = new User({ name, email, password_hash: bcrypt.hashSync(password || 'password123', 10), role: 'doctor' });
    await u.save({ session });
    
    await DoctorProfile.create([{
      user_id: u.id, specialization, bio: bio || '',
      working_start: workingStart || '09:00', working_end: workingEnd || '17:00', slot_duration: Number(slotDuration || 30)
    }], { session });
    
    await session.commitTransaction();
    res.status(201).json({ message: 'Doctor created' });
  } catch (e) {
    await session.abortTransaction();
    res.status(409).json({ message: e.code === 11000 ? 'Email already exists' : e.message });
  } finally {
    session.endSession();
  }
});

app.post('/api/admin/doctors/:id/leave', auth, role('admin'), async (req, res) => {
  const id = req.params.id;
  const { date, reason = 'Doctor unavailable' } = req.body;
  try {
    await Leave.create({ doctor_id: id, leave_date: date, reason });
    const affected = await Appointment.find({ doctor_id: id, appointment_date: date, status: 'booked' })
      .populate('patient_id', 'email')
      .populate({ path: 'doctor_id', populate: { path: 'user_id', select: 'name' } });
      
    for (const a of affected) {
      a.status = 'cancelled';
      a.cancellation_reason = `Doctor leave: ${reason}`;
      await a.save();
      await notify(a.id, a.patient_id.email, 'Doctor leave', `Your appointment with ${a.doctor_id.user_id.name} on ${date} was cancelled. Reason: ${reason}`);
    }
    res.json({ message: 'Leave added', affectedAppointments: affected.length });
  } catch(e) {
    res.status(409).json({ message: 'Leave already exists for this date' });
  }
});

app.delete('/api/admin/doctors/:id/leave', auth, role('admin'), async (req, res) => {
  await Leave.deleteOne({ doctor_id: req.params.id, leave_date: req.body.date });
  res.json({ message: 'Leave removed' });
});

// Dashboard
app.get('/api/dashboard', auth, async (req, res) => {
  const x = {};
  if (req.user.role === 'patient') {
    x.total = await Appointment.countDocuments({ patient_id: req.user.id });
    x.upcoming = await Appointment.countDocuments({ patient_id: req.user.id, status: 'booked', appointment_date: { $gte: new Date().toISOString().slice(0,10) } });
    x.completed = await Appointment.countDocuments({ patient_id: req.user.id, status: 'completed' });
    const { Reminder } = await import('./db.js');
    x.reminders = await Reminder.countDocuments({ patient_id: req.user.id, status: 'active' });
  } else if (req.user.role === 'doctor') {
    const d = await DoctorProfile.findOne({ user_id: req.user.id });
    if(d) {
      const today = new Date().toISOString().slice(0,10);
      x.today = await Appointment.countDocuments({ doctor_id: d.id, appointment_date: today, status: 'booked' });
      x.upcoming = await Appointment.countDocuments({ doctor_id: d.id, status: 'booked', appointment_date: { $gte: today } });
      x.completed = await Appointment.countDocuments({ doctor_id: d.id, status: 'completed' });
      x.highUrgency = await Appointment.countDocuments({ doctor_id: d.id, ai_urgency: 'High', status: 'booked' });
    }
  } else {
    x.patients = await User.countDocuments({ role: 'patient' });
    x.doctors = await User.countDocuments({ role: 'doctor' });
    x.appointments = await Appointment.countDocuments();
    x.cancelled = await Appointment.countDocuments({ status: 'cancelled' });
  }
  res.json(x);
});

// ── Google Calendar OAuth ─────────────────────────────────────────────────────
app.get('/api/calendar/connect', (req, res) => {
  const url = getGoogleAuthUrl();
  if (!url) return res.json({ configured: false, message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env' });
  res.redirect(url);
});
app.get('/api/calendar/oauth/callback', async (req, res) => {
  try {
    const tokens = await exchangeGoogleCode(req.query.code);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px"><h2>✅ Google Calendar Connected!</h2><p><strong>Copy this refresh token into your <code>.env</code> as <code>GOOGLE_REFRESH_TOKEN</code> (or Vercel dashboard):</strong></p><textarea rows="4" style="width:100%;font-family:monospace;padding:8px" onclick="this.select()">${tokens.refresh_token}</textarea><p>Then close this tab.</p></body></html>`);
  } catch (e) {
    res.status(500).send(`<h2>❌ OAuth Error</h2><pre>${e.message}</pre>`);
  }
});

// ── Vercel Cron Endpoints ─────────────────────────────────────────────────────
app.get('/api/cron/reminders', async (req, res) => {
  await processDueReminders();
  res.json({ ok: true, job: 'reminders' });
});

app.get('/api/cron/retries', async (req, res) => {
  const failed = await Notification.find({ status: 'failed', attempts: { $lt: 3 } });
  for (const n of failed) {
    try {
      const out = await sendEmail({ to: n.recipient_email, subject: `CareFlow: ${n.type} (Retry)`, text: n.message });
      n.status = out.delivered ? 'sent' : 'failed';
      n.attempts += 1;
      await n.save();
    } catch(e) {
      n.attempts += 1;
      n.last_error = e.message;
      await n.save();
    }
  }
  res.json({ ok: true, job: 'retries' });
});

// ── Local Background Workers (Disabled in Vercel) ─────────────────────────────
if (process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1') {
  setInterval(() => processDueReminders().catch(e => console.error('Reminder job:', e)), 60_000);
  setInterval(() => {
    fetch(`http://localhost:${PORT}/api/cron/retries`).catch(()=>{});
  }, 60_000 * 5);
}

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

if (process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`\n🏥 CareFlow running locally at http://localhost:${PORT}\n`));
}

export default app;
