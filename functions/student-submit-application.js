const sql = require('mssql');
const jwt = require('jsonwebtoken');

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

const JWT_SECRET = process.env.JWT_SECRET;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let pool;

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized - Missing or invalid token' }),
      };
    }

    const token = authHeader.substring(7);
    let decoded;

    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized - Invalid token' }),
      };
    }

    if (decoded.role !== 'STUDENT') {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized - Invalid role' }),
      };
    }

    const { student_id, college_id } = decoded;

    const body = JSON.parse(event.body || '{}');
    const {
      blood_group,
      address,
      department,
      year_of_study,
      semester,
    } = body;

    if (!address || typeof address !== 'string' || !address.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Address is required' }),
      };
    }

    if (!department || typeof department !== 'string' || !department.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Department is required' }),
      };
    }

    if (!year_of_study || typeof year_of_study !== 'number' || year_of_study < 1 || year_of_study > 4) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Valid year of study (1-4) is required' }),
      };
    }

    if (!semester || typeof semester !== 'number' || semester < 1 || semester > 8) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Valid semester (1-8) is required' }),
      };
    }

    pool = await sql.connect(dbConfig);

    const existingAppResult = await pool
      .request()
      .input('student_id', sql.Int, student_id)
      .query(`
        SELECT application_id, status
        FROM student_applications
        WHERE student_id = @student_id
          AND status IN ('UNDER_REVIEW', 'APPROVED', 'FINAL_APPROVED')
      `);

    if (existingAppResult.recordset.length > 0) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'You already have an active application' }),
      };
    }

    await pool
      .request()
      .input('student_id', sql.Int, student_id)
      .input('blood_group', sql.VarChar(5), blood_group || null)
      .input('address', sql.VarChar(500), address.trim())
      .input('department', sql.VarChar(100), department.trim())
      .input('year_of_study', sql.Int, year_of_study)
      .input('semester', sql.Int, semester)
      .query(`
        INSERT INTO student_applications (
          student_id,
          blood_group,
          address,
          department,
          year_of_study,
          semester,
          status,
          submitted_at
        )
        VALUES (
          @student_id,
          @blood_group,
          @address,
          @department,
          @year_of_study,
          @semester,
          'UNDER_REVIEW',
          SYSUTCDATETIME()
        )
      `);

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        message: 'Application submitted successfully',
      }),
    };
  } catch (error) {
    console.error('Error in student-submit-application:', error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'An error occurred processing your request',
      }),
    };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};