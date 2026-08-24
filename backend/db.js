import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const opts = {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  toJSON: {
    virtuals: true,
    transform: (doc, ret) => {
      ret.id = ret._id.toString();
      delete ret._id;
      delete ret.__v;
    }
  }
};

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true },
  role: { type: String, enum: ['patient', 'doctor', 'admin'], required: true }
}, opts);

const doctorProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  specialization: { type: String, required: true },
  bio: { type: String, default: '' },
  working_start: { type: String, default: '09:00' },
  working_end: { type: String, default: '17:00' },
  slot_duration: { type: Number, default: 30 }
}, opts);

const leaveSchema = new mongoose.Schema({
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile', required: true },
  leave_date: { type: String, required: true },
  reason: { type: String, default: 'Doctor unavailable' }
}, opts);
leaveSchema.index({ doctor_id: 1, leave_date: 1 }, { unique: true });

const appointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile', required: true },
  appointment_date: { type: String, required: true },
  start_time: { type: String, required: true },
  end_time: { type: String, required: true },
  status: { type: String, default: 'booked' }, // booked, held, completed, cancelled
  symptoms: { type: String, default: '' },
  ai_urgency: { type: String, default: 'Low' },
  ai_summary: { type: String, default: '' },
  doctor_notes: { type: String, default: '' },
  prescription: { type: String, default: '' },
  patient_summary: { type: String, default: '' },
  cancellation_reason: { type: String, default: '' },
  calendar_event_id: { type: String, default: '' }
}, opts);
appointmentSchema.index({ doctor_id: 1, appointment_date: 1, start_time: 1 }, { unique: true });

const notificationSchema = new mongoose.Schema({
  appointment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  recipient_email: { type: String, required: true },
  type: { type: String, required: true },
  status: { type: String, default: 'queued' },
  attempts: { type: Number, default: 0 },
  last_error: { type: String, default: '' },
  message: { type: String, required: true },
  sent_at: { type: Date }
}, opts);

const reminderSchema = new mongoose.Schema({
  appointment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  schedule: { type: String, required: true },
  next_run: { type: Date },
  status: { type: String, default: 'active' }
}, opts);

export const User = mongoose.model('User', userSchema);
export const DoctorProfile = mongoose.model('DoctorProfile', doctorProfileSchema);
export const Leave = mongoose.model('Leave', leaveSchema);
export const Appointment = mongoose.model('Appointment', appointmentSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const Reminder = mongoose.model('Reminder', reminderSchema);

export async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set in .env');
    await mongoose.connect(uri);
    console.log('📦 MongoDB Atlas Connected');
    await seed();
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    // Don't exit process in serverless, let routes return 500
  }
}

async function seed() {
  const adminExists = await User.findOne({ email: 'admin@careflow.local' });
  if (adminExists) return;

  console.log('🌱 Seeding demo accounts...');
  const hash = bcrypt.hashSync('password123', 10);
  
  await User.create({ name: 'System Admin', email: 'admin@careflow.local', password_hash: hash, role: 'admin' });
  const docUser = await User.create({ name: 'Dr. Aisha Sharma', email: 'doctor@careflow.local', password_hash: hash, role: 'doctor' });
  await User.create({ name: 'Vaibhavi Patient', email: 'patient@careflow.local', password_hash: hash, role: 'patient' });

  await DoctorProfile.create({
    user_id: docUser._id,
    specialization: 'General Medicine',
    bio: 'Preventive care, common illnesses and patient education.',
    working_start: '09:00',
    working_end: '17:00',
    slot_duration: 30
  });
  console.log('✅ Seeding complete.');
}
