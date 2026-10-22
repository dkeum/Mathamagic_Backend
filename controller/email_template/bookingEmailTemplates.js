// Placeholders like {{appointment.only_start_date}} are filled in by sendBookingEmail in 5_Bookings.js.
// Available placeholders:
//   user.name
//   appointment.only_start_date, appointment.only_start_time, appointment.timezone
//   appointment.meeting_location
//   appointment.add_to_google_calendar, appointment.add_to_ical_outlook
//   appointment.cancellation_link, appointment.reschedule_link

module.exports = {
    email1: {
        title: "Booked Call Confirmation",
        subject: "[Important] How to prepare for your call",
        body: `Hey hey! It’s {{user.name}}

Thanks for scheduling a time to speak with me regarding your child’s math studies.

Here are the call details:
{{appointment.only_start_date}}
{{appointment.only_start_time}} {{appointment.timezone}}

Link to join the google meets call: {{appointment.meeting_location}}

On our call we will be mapping out a plan to help your child build the proper foundations in Grade 9-10 math so they can feel more confident and achieve higher grades.

Before that call there is one thing you need to do and that is to read the document I’ve put together:

Click here to read it <<< https://mathmagick.com/assessment-10

It’s a quick read and it’s especially for parents like you who are wanting to give their child the edge. This will make sure we can hit the ground running on the call.

Thanks 
{{user.name}}

PS - I will be reaching out personally to confirm your booking so please watch out for that and make sure you reply so I can keep the slot open.`,
    },

    email2: {
        title: "24 Hour Booked Call Email Reminder",
        subject: "Your Mathmagick call is tomorrow",
        body: `Hey hey! It’s {{user.name}}

Just a quick reminder that we’re speaking tomorrow regarding your child’s Math studies.

Here are the call details:
{{appointment.only_start_date}}
{{appointment.only_start_time}} {{appointment.timezone}}

Link to join the google meets call: {{appointment.meeting_location}}

You can add the appointment to your calendar here:  
Google Calendar: {{appointment.add_to_google_calendar}}
iCal/Outlook:
{{appointment.add_to_ical_outlook}}

If you need to cancel please give 2 hours notice and click here:  {{appointment.cancellation_link}}

If you'd like to reschedule you can by clicking here:  {{appointment.reschedule_link}}

On our call we’ll look at where your child is currently at in Grade 9-10 math, identify any gaps in their foundation, and map out the best path forward.

The goal is to help your child build the foundation they need to become more confident in math and achieve higher grades.

This is the same approach we use in the Foundation Building Program, where we assess current knowledge, find gaps, properly build the foundation, and then work upwards while using challenging problems and technology to develop confidence and critical thinking.

For example, Hudson went from struggling at 60% to 79% in 12 weeks and is now acing his current math class.

Mohammad went from 69% to 98% for his final math grade and gained more confidence in his homework.

If you haven't already, make sure you read the short document I sent you before our call:

Click here to read it <<< https://mathmagick.com/program-offer

It will help us make the most of our time together and allow us to hit the ground running.

Looking forward to speaking with you!

Thanks 
{{user.name}}

PS - Please reply when I reach out to confirm your booking so I know you’re still able to make the call.`,
    },

    email3: {
        title: "1 Hour Booked Call Email Reminder",
        subject: "We’re speaking in 1 hour",
        body: `Hey hey! It’s {{user.name}}

Just a quick reminder that we’re speaking in about 1 hour regarding your child’s Math studies.

Here are the call details:
{{appointment.only_start_date}}
{{appointment.only_start_time}} {{appointment.timezone}}

Link to join the google meets call: {{appointment.meeting_location}}

If you need to cancel please give 2 hours notice and click here:  {{appointment.cancellation_link}}

If you'd like to reschedule you can by clicking here:  {{appointment.reschedule_link}}

On the call, we’ll look at your child’s current math situation, identify where the biggest gaps are, and discuss a plan to help them build stronger foundations, become more confident, and achieve higher grades.

The Foundation Building Program is built around finding the gaps in a student’s current knowledge, properly rebuilding those foundations, and then working upwards. We also use challenging math problems and technology to help students develop confidence and stronger critical-thinking skills.

Hudson went from struggling at 60% to 79% in 12 weeks and is now acing his current math class.

Mohammad went from 69% to 98% for his final math grade and gained more confidence in homework.

I'll see you shortly!

Thanks 
{{user.name}}

PS - Please make sure you have your Google Meet link ready before the call so we can get started right away.`,
    },
};
