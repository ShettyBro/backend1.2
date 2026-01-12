const sql = require('mssql');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
require('dotenv').config();

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
};

const JWT_SECRET = process.env.JWT_SECRET;
const AZURE_STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ============================================================================
// HELPER: Verify JWT and extract student info
// ============================================================================
const verifyAuth = (event) => {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.substring(7);
  const decoded = jwt.verify(token, JWT_SECRET);

  if (decoded.role !== 'STUDENT') {
    throw new Error('Unauthorized: Student role required');
  }

  return {
    student_id: decoded.student_id,
    usn: decoded.usn,
    college_id: decoded.college_id,
  };
};

// ============================================================================
// HELPER: Generate SAS URL for blob upload
// ============================================================================
const generateSASUrl = (blobPath) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    AZURE_STORAGE_ACCOUNT_NAME,
    AZURE_STORAGE_ACCOUNT_KEY
  );

  const blobServiceClient = new BlobServiceClient(
    `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
    sharedKeyCredential
  );

  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobPath);

  const expiresOn = new Date(Date.now() + 25 * 60 * 1000); // 25 minutes

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER_NAME,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('w'), // Write only
      expiresOn,
    },
    sharedKeyCredential
  ).toString();

  return `${blobClient.url}?${sasToken}`;
};

// ============================================================================
// ACTION: init_application
// ============================================================================
const initApplication = async (pool, auth, body) => {
  const { blood_group, address, department, year_of_study, semester } = body;

  // Validate required fields
  if (!blood_group || !address || !department || !year_of_study || !semester) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'All fields are required' }),
    };
  }

  // Get student's college_code
  const studentResult = await pool
    .request()
    .input('student_id', sql.Int, auth.student_id)
    .query(`
      SELECT c.college_code
      FROM students s
      INNER JOIN colleges c ON s.college_id = c.college_id
      WHERE s.student_id = @student_id
    `);

  if (studentResult.recordset.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Student not found' }),
    };
  }

  const college_code = studentResult.recordset[0].college_code;

  // Check if student has existing applications
  const existingApp = await pool
    .request()
    .input('student_id', sql.Int, auth.student_id)
    .query(`
      SELECT application_id, status
      FROM student_applications
      WHERE student_id = @student_id
      ORDER BY application_id DESC
    `);

  // Block if status is SUBMITTED, UNDER_REVIEW, APPROVED, or FINAL_APPROVED
  if (existingApp.recordset.length > 0) {
    const latestStatus = existingApp.recordset[0].status;
    if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'FINAL_APPROVED'].includes(latestStatus)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: `Cannot apply. Your application is currently ${latestStatus}`,
        }),
      };
    }
  }

  // Check reapply_count - block if >= 2 rejections
  const studentInfo = await pool
    .request()
    .input('student_id', sql.Int, auth.student_id)
    .query(`SELECT reapply_count FROM students WHERE student_id = @student_id`);

  if (studentInfo.recordset.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Student not found' }),
    };
  }

  const reapply_count = studentInfo.recordset[0].reapply_count;

  if (reapply_count >= 2) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: 'You have reached the maximum number of reapplications (2 rejections)',
      }),
    };
  }

  // Generate session_id
  const session_id = crypto.randomBytes(32).toString('hex');
  const expires_at = new Date(Date.now() + 25 * 60 * 1000); // 25 minutes

  // Create session (no application_id yet, so we'll use NULL or skip FK temporarily)
  // NOTE: We'll store session data without application_id since we haven't created the application yet
  await pool
    .request()
    .input('session_id', sql.VarChar(64), session_id)
    .input('student_id', sql.Int, auth.student_id)
    .input('expires_at', sql.DateTime2, expires_at)
    .input('blood_group', sql.VarChar(5), blood_group)
    .input('address', sql.VarChar(500), address.trim())
    .input('department', sql.VarChar(100), department)
    .input('year_of_study', sql.Int, parseInt(year_of_study))
    .input('semester', sql.Int, parseInt(semester))
    .input('college_code', sql.VarChar(20), college_code)
    .query(`
      INSERT INTO application_sessions (
        session_id, student_id, application_id, expires_at
      )
      VALUES (@session_id, @student_id, NULL, @expires_at)
    `);

  // Store form data in a temporary session table or in-memory
  // For simplicity, we'll store it in a separate session_data table
  // But since that doesn't exist, we'll pass it back to frontend and they'll send it again on finalize
  
  // Generate SAS URLs for 3 documents
  const blobBasePath = `${college_code}/${auth.usn}/application`;
  
  const upload_urls = {
    aadhaar: generateSASUrl(`${blobBasePath}/aadhaar`),
    college_id_card: generateSASUrl(`${blobBasePath}/college_id_card`),
    marks_card_10th: generateSASUrl(`${blobBasePath}/marks_card_10th`),
  };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      session_id,
      upload_urls,
      expires_at: expires_at.toISOString(),
      message: 'Session created. Please upload documents within 25 minutes.',
    }),
  };
};

// ============================================================================
// ACTION: finalize_application
// ============================================================================
const finalizeApplication = async (pool, auth, body) => {
  const { session_id, blood_group, address, department, year_of_study, semester } = body;

  if (!session_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'session_id is required' }),
    };
  }

  // Validate session
  const sessionResult = await pool
    .request()
    .input('session_id', sql.VarChar(64), session_id)
    .input('student_id', sql.Int, auth.student_id)
    .query(`
      SELECT expires_at
      FROM application_sessions
      WHERE session_id = @session_id AND student_id = @student_id
    `);

  if (sessionResult.recordset.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Invalid or expired session' }),
    };
  }

  const expires_at = new Date(sessionResult.recordset[0].expires_at);
  if (Date.now() > expires_at.getTime()) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Session expired. Please restart.' }),
    };
  }

  // Validate required fields
  if (!blood_group || !address || !department || !year_of_study || !semester) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'All fields are required' }),
    };
  }

  // Get college_code
  const studentResult = await pool
    .request()
    .input('student_id', sql.Int, auth.student_id)
    .query(`
      SELECT c.college_code
      FROM students s
      INNER JOIN colleges c ON s.college_id = c.college_id
      WHERE s.student_id = @student_id
    `);

  if (studentResult.recordset.length === 0) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Student not found' }),
    };
  }

  const college_code = studentResult.recordset[0].college_code;

  // Verify all 3 documents exist in Azure Blob (optional check)
  // For now, we'll trust frontend uploaded them successfully
  
  // Insert into student_applications with status='SUBMITTED'
  const insertResult = await pool
    .request()
    .input('student_id', sql.Int, auth.student_id)
    .input('blood_group', sql.VarChar(5), blood_group)
    .input('address', sql.VarChar(500), address.trim())
    .input('department', sql.VarChar(100), department)
    .input('year_of_study', sql.Int, parseInt(year_of_study))
    .input('semester', sql.Int, parseInt(semester))
    .input('college_code', sql.VarChar(20), college_code)
    .query(`
      INSERT INTO student_applications (
        student_id, blood_group, address, department, year_of_study, semester, college_code, status, submitted_at
      )
      OUTPUT INSERTED.application_id
      VALUES (
        @student_id, @blood_group, @address, @department, @year_of_study, @semester, @college_code, 'SUBMITTED', SYSUTCDATETIME()
      )
    `);

  const application_id = insertResult.recordset[0].application_id;

  // Insert 3 document records
  const blobBasePath = `${college_code}/${auth.usn}/application`;
  const documents = [
    { type: 'AADHAR', url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/aadhaar` },
    { type: 'COLLEGE_ID', url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/college_id_card` },
    { type: 'SSLC', url: `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobBasePath}/marks_card_10th` },
  ];

  for (const doc of documents) {
    await pool
      .request()
      .input('application_id', sql.Int, application_id)
      .input('document_type', sql.VarChar(50), doc.type)
      .input('document_url', sql.VarChar(500), doc.url)
      .query(`
        INSERT INTO application_documents (application_id, document_type, document_url, uploaded_at)
        VALUES (@application_id, @document_type, @document_url, SYSUTCDATETIME())
      `);
  }

  // Delete session
  await pool
    .request()
    .input('session_id', sql.VarChar(64), session_id)
    .query(`DELETE FROM application_sessions WHERE session_id = @session_id`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: 'Application submitted successfully',
      application_id,
    }),
  };
};

// ============================================================================
// MAIN HANDLER
// ============================================================================
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { action } = body;

  if (!action) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'action is required' }),
    };
  }

  let pool;
  try {
    // Verify authentication
    const auth = verifyAuth(event);

    // Connect to database
    pool = await sql.connect(dbConfig);

    // Route to action
    if (action === 'init_application') {
      return await initApplication(pool, auth, body);
    } else if (action === 'finalize_application') {
      return await finalizeApplication(pool, auth, body);
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action' }),
      };
    }
  } catch (error) {
    console.error('Error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      number: error.number
    });

    if (error.message.includes('Authorization') || error.message.includes('Unauthorized')) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: error.message }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: error.message // ✅ Send actual error to frontend for debugging
      }),
    };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};