**System Design Write-up – CareFlow Healthcare Appointment Manager**



CareFlow is a healthcare appointment management system designed to allow patients to view doctors, select available time slots, book appointments, and receive appointment-related notifications. Doctors can view their appointments, complete visits, add clinical notes and prescriptions, while administrators can manage doctors and doctor leaves. The system uses a Node.js backend, REST APIs, and a database for persistent storage.



&#x20;**1. Double-Booking Prevention**



Preventing double booking is a critical requirement because two patients must never be assigned the same doctor and time slot. CareFlow uses both frontend availability checking and backend validation.



When a patient selects a doctor and date, the system generates the doctor's available slots based on their working hours and slot duration. Before displaying a slot as available, the backend checks the appointments table to determine whether another booked appointment already exists for the same doctor, date, and start time.



The database also provides an additional safety layer through a unique constraint:



`UNIQUE(doctor\_id, appointment\_date, start\_time)`



During booking, the backend performs another availability check inside a database transaction immediately before inserting the appointment. If another appointment has already occupied the slot, the transaction is rejected and the patient receives an appropriate error message. This prevents race conditions where two users attempt to book the same slot at nearly the same time.



&#x20;**2. Doctor Leave Conflict Handling**



Doctor availability is also affected by planned leave. CareFlow stores leave information separately in the `leaves` table, including the doctor profile, leave date, and reason.



When slots are requested for a particular date, the backend checks whether the doctor has a leave entry for that date. If leave exists, no appointment slots are returned for that doctor.



The system also handles the situation where a doctor adds leave after appointments have already been booked. When an administrator adds leave, CareFlow searches for all booked appointments associated with that doctor on the leave date. These appointments are automatically changed to `cancelled`, and the cancellation reason records that the doctor is unavailable. Patients are notified about the cancellation. This prevents appointments from remaining active when the doctor is not available.



&#x20;**3. Slot Hold Mechanism**



CareFlow uses a lightweight slot-validation mechanism rather than permanently reserving a slot while a patient is filling the booking form. When the patient selects a date, the frontend requests the latest slot availability from the backend.



A selected slot is temporarily represented in the frontend using the `chosen Slot` value. However, this selection does not itself reserve the appointment. When the patient finally clicks Confirm Appointment, the backend performs a fresh availability check. This design prevents stale frontend information from causing incorrect bookings.



The actual appointment is created only after the backend confirms that the slot is still available. The database transaction then inserts the appointment. Therefore, the effective slot hold occurs at the final booking stage rather than relying on an unsafe client-side reservation.



&#x20;**4. Notification Failure Handling**



CareFlow sends notifications for important events such as booking confirmations, cancellations, doctor leave cancellations, and post-visit summaries. Email delivery is handled separately from the core appointment transaction.



If SMTP configuration is unavailable, the system uses a console fallback, recording the intended recipient, subject, and message rather than causing the appointment operation to fail. If SMTP is configured but email delivery encounters an error, the error is logged while the main appointment operation remains successful.



This separation is important because notification delivery is an external dependency. A temporary email failure should not undo a valid appointment booking or cancellation. Notifications are also stored in the database with their recipient, type, message, and status, providing a record of notification activity.



Overall, CareFlow prioritizes database-level consistency, transactional booking, leave-aware scheduling, and fault-tolerant notifications, ensuring that appointment operations remain reliable even when multiple users interact with the system simultaneously.



