let express = require("express");
const cors = require("cors");
let path = require("path");
const { Pool } = require("pg");
require("dotenv").config();
const { DATABASE_URL } = process.env;

let app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        require: true,
    },
});

async function getPostgresVersion() {
    const client = await pool.connect();
    try {
        const response = await client.query("SELECT version()");
        console.log(response.rows[0]);
    } finally {
        client.release();
    }
};

getPostgresVersion();

// API Endpoints
// GET /barbers - Retrieve a list of all barbers
// GET /barbers/:id/schedule - Retrieve the schedule for a specific barber by ID
// GET /barbers/:id/schedule/available - Retrieve available schedules for a specific barber by ID
// POST /booking/create - Create a new booking (requires Firebase token)
// GET /booking/read - Retrieve the current booking for the user (requires Firebase token)
// PUT /booking/update - Update an existing booking (requires Firebase token)
// DELETE /booking/delete - Delete a booking (requires Firebase token)

app.get("/barbers", async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM barbers');
        res.status(200).json(result.rows);
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get("/barbers/:id/schedule", async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM schedules WHERE barber_id = $1 ORDER BY date, time, id', [id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get("/barbers/:id/schedule/available", async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT * FROM schedules WHERE barber_id = $1 AND status = $2 ORDER BY date, time, id', [id, 'Available']);
        res.status(200).json(result.rows);
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Create, Read, Update, Delete (CRUD) for Booking System (requires Firebase token)
app.post("/booking/create", async (req, res) => {
    const { user_uid, barber_id, date, time, name, phone_number } = req.body;

    if (!barber_id || !date || !time || !name || !phone_number) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const client = await pool.connect();
    try {
        const scheduleResult = await client.query(
            'SELECT id FROM schedules WHERE barber_id = $1 AND date = $2 AND time = $3 AND status = $4', 
            [barber_id, date, time, 'Available']
        );

        if (scheduleResult.rows.length === 0) {
            return res.status(404).json({ error: "No available schedule found" })
        }

        const schedule = scheduleResult.rows[0];

        await client.query(
            'INSERT INTO bookings (schedule_id, user_uid, name, phone_number) VALUES ($1, $2, $3, $4)', 
            [schedule.id, user_uid, name, phone_number]
        );
        await client.query(
            'UPDATE schedules SET status = $1 WHERE id = $2', 
            ['Reserved', schedule.id]
        );
        res.status(201).json({ message: "Booking created successfully" });
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get("/booking/read", async (req, res) => {
    const { user_uid } = req.query;

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT barbers.name AS barber, schedules.date, schedules.time, bookings.name, bookings.phone_number FROM bookings INNER JOIN schedules ON bookings.schedule_id = schedules.id INNER JOIN barbers ON schedules.barber_id = barbers.id WHERE bookings.user_uid = $1',  
            [user_uid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "No reservation found" });
        }
        
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.put("/booking/update", async (req, res) => {
    const { user_uid, barber_id, date, time, name, phone_number } = req.body;
    
    if (!barber_id || !date || !time || !name || !phone_number) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const client = await pool.connect();
    try {
        const oldBookingResult = await client.query(
            'SELECT schedule_id from bookings WHERE user_uid = $1', 
            [user_uid]
        );

        if (oldBookingResult.rows.length === 0) {
            return res.status(404).json({ error: "No reservation found for this user" })
        }

        const newScheduleResult = await client.query(
            'SELECT id FROM schedules WHERE barber_id = $1 AND date = $2 AND time = $3', 
            [barber_id, date, time]
        );

        if (newScheduleResult.rows.length === 0) {
            return res.status(404).json({ error: "No available schedule found" });
        }

        if (newScheduleResult.rows[0].status === 'Reserved') {
            return res.status(400).json({ error: "Selected schedule is reserved" });
        }

        const oldSchedule_id = oldBookingResult.rows[0].schedule_id;
        const newSchedule_id = newScheduleResult.rows[0].id;

        // Update name and phone number only
        if (oldSchedule_id === newSchedule_id) {
            await client.query(
                'UPDATE bookings SET name = $1, phone_number = $2 WHERE user_uid = $3', 
                [name, phone_number, user_uid]
            );
            return res.status(200).json({ message: "Booking updated successfully" });
        }

        await client.query(
            'UPDATE bookings SET schedule_id = $1, name = $2, phone_number = $3 WHERE user_uid = $4', 
            [newSchedule_id, name, phone_number, user_uid]
        );

        await client.query(
            'UPDATE schedules SET status = $1 WHERE id = $2', 
            ['Available', oldSchedule_id]
        );

        await client.query(
            'UPDATE schedules SET status = $1 WHERE id = $2', 
            ['Reserved', newSchedule_id]
        );
        res.status(200).json({ message: "Booking updated successfully" });
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.delete("/booking/delete", async (req, res) => {
    const { user_uid } = req.body;
    
    const client = await pool.connect();
    try {
        const bookingResult = await client.query(
            'SELECT schedule_id FROM bookings WHERE user_uid = $1', 
            [user_uid]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: "No reservation found for this user" });
        }

        const schedule_id = bookingResult.rows[0].schedule_id;

        await client.query(
            'DELETE FROM bookings WHERE schedule_id = $1 AND user_uid = $2', 
            [schedule_id, user_uid]
        );
        await client.query(
            'UPDATE schedules SET status = $1 WHERE id = $2', 
            ['Available', schedule_id]
        );
        res.status(200).json({ message: "Booking cancelled succesfully" });
    } catch (error) {
        console.log("Error: ", error.message);
        return res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname + "/public/index.html"));
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname + "/public/error.html"));
});

// http://localhost:3000
app.listen(3000, () => {
    console.log("App is listening on port 3000");
});
