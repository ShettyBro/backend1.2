const sql = require('mssql');
const jwt = require('jsonwebtoken');
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const crypto = require('crypto');

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
const STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const CONTAINER_NAME = 'student-documents';
const SESSION_EXPIRY_MINUTES = 25;

// Generate SAS URL for blob upload
const generateSASUrl = (blobName) => {
  const sharedKeyCredential = new StorageSharedKeyCredential(
    STORAGE_ACCOUNT_NAME,
    STORAGE_ACCOUNT_KEY
  );

  const now = new Date();

  const sasOptions = {
    containerName: CONTAINER_NAME,
    blobName: blobName,
    permissions: BlobSASPermissions.parse('cw'),
    startsOn: new Date(now.getTime() - 1 * 60 * 1000),
    expiresOn: new Date(now.getTime() + SESSION_EXPIRY_MINUTES * 60 * 1000),
    version: '2021-08-06',
  };

  const sasToken = generateBlobSASQueryParameters(
    sasOptions,
    sharedKeyCredential
  ).toString();

  return `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${blobName}?${sasToken}`;
};

// Check if blob exists in Azure Storage
const checkBlobExists = async (blobName) => {
  try {
    const blobServiceClient = new BlobServiceClient(
      `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
      new StorageSharedKeyCredential(STORAGE_ACCOUNT_NAME, STORAGE_ACCOUNT_KEY)
    );

    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient(blobName);

    return await blobClient.exists();
  } catch (error) {
    console.error('Error checking blob existence:', error);
    return false;
  }
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

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

  let pool;

  try {
    // Verify JWT
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

    const { student_id, usn } = decoded;

    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    pool = await sql.connect(dbConfig);

    // ===== ACTION: save_details =====
    if (action === 'save_details') {
      const {
        blood_group,
        address,
        department,
        year_of_study,
        semester,
        college_id,
        college_code,
      } = body;

      // Validate all required fields
      if (!blood_group || typeof blood_group !== 'string' || !blood_group.trim()) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Blood group is required' }),
        };
      }

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

      if (!college_id || !college_code) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'College information is required' }),
        };
      }

      // Check if student already has an application
      const existingAppResult = await pool
        .request()
        .input('student_id', sql.Int, student_id)
        .query(`
          SELECT application_id, status
          FROM student_applications
          WHERE student_id = @student_id
        `);

      if (existingAppResult.recordset.length > 0) {
        const existingApp = existingAppResult.recordset[0];
        const { application_id, status } = existingApp;

        // Block if already submitted or approved
        if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'FINAL_APPROVED'].includes(status)) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({ 
              error: 'You already have an active application. Cannot submit a new one.' 
            }),
          };
        }

        // Check reapply count if rejected
        if (status === 'REJECTED') {
          const reapplyResult = await pool
            .request()
            .input('student_id', sql.Int, student_id)
            .query(`SELECT reapply_count FROM students WHERE student_id = @student_id`);

          const reapplyCount = reapplyResult.recordset[0]?.reapply_count || 0;

          if (reapplyCount > 0) {
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({ 
                error: 'You have exceeded the reapply limit. Cannot submit application.' 
              }),
            };
          }

          // Allow reapply - UPDATE existing application
          await pool
            .request()
            .input('application_id', sql.Int, application_id)
            .input('blood_group', sql.VarChar(5), blood_group.trim())
            .input('address', sql.VarChar(500), address.trim())
            .input('department', sql.VarChar(100), department.trim())
            .input('year_of_study', sql.Int, year_of_study)
            .input('semester', sql.Int, semester)
            .input('college_id', sql.Int, college_id)
            .input('college_code', sql.VarChar(20), college_code)
            .query(`
              UPDATE student_applications
              SET 
                blood_group = @blood_group,
                address = @address,
                department = @department,
                year_of_study = @year_of_study,
                semester = @semester,
                college_id = @college_id,
                college_code = @college_code,
                status = 'IN_PROGRESS',
                submitted_at = NULL,
                reviewed_at = NULL,
                rejected_reason = NULL
              WHERE application_id = @application_id
            `);

          // Increment reapply count
          await pool
            .request()
            .input('student_id', sql.Int, student_id)
            .query(`
              UPDATE students 
              SET reapply_count = reapply_count + 1 
              WHERE student_id = @student_id
            `);

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
              message: 'Application details updated successfully',
              application_id: application_id
            }),
          };
        }

        // If status is IN_PROGRESS, allow UPDATE
        await pool
          .request()
          .input('application_id', sql.Int, application_id)
          .input('blood_group', sql.VarChar(5), blood_group.trim())
          .input('address', sql.VarChar(500), address.trim())
          .input('department', sql.VarChar(100), department.trim())
          .input('year_of_study', sql.Int, year_of_study)
          .input('semester', sql.Int, semester)
          .input('college_id', sql.Int, college_id)
          .input('college_code', sql.VarChar(20), college_code)
          .query(`
            UPDATE student_applications
            SET 
              blood_group = @blood_group,
              address = @address,
              department = @department,
              year_of_study = @year_of_study,
              semester = @semester,
              college_id = @college_id,
              college_code = @college_code
            WHERE application_id = @application_id
          `);

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            message: 'Application details updated successfully',
            application_id: application_id
          }),
        };
      }

      // No existing application - INSERT new one
      const insertResult = await pool
        .request()
        .input('student_id', sql.Int, student_id)
        .input('blood_group', sql.VarChar(5), blood_group.trim())
        .input('address', sql.VarChar(500), address.trim())
        .input('department', sql.VarChar(100), department.trim())
        .input('year_of_study', sql.Int, year_of_study)
        .input('semester', sql.Int, semester)
        .input('college_id', sql.Int, college_id)
        .input('college_code', sql.VarChar(20), college_code)
        .query(`
          INSERT INTO student_applications (
            student_id,
            blood_group,
            address,
            department,
            year_of_study,
            semester,
            college_id,
            college_code,
            status,
            submitted_at
          )
          OUTPUT INSERTED.application_id
          VALUES (
            @student_id,
            @blood_group,
            @address,
            @department,
            @year_of_study,
            @semester,
            @college_id,
            @college_code,
            'IN_PROGRESS',
            NULL
          )
        `);

      const application_id = insertResult.recordset[0].application_id;

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ 
          message: 'Application details saved successfully',
          application_id: application_id
        }),
      };
    }

    // ===== ACTION: generate_upload_urls =====
    if (action === 'generate_upload_urls') {
      // Get application
      const appResult = await pool
        .request()
        .input('student_id', sql.Int, student_id)
        .query(`
          SELECT application_id, status, college_code
          FROM student_applications
          WHERE student_id = @student_id
        `);

      if (appResult.recordset.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'No application found. Please save details first.' }),
        };
      }

      const { application_id, status, college_code } = appResult.recordset[0];

      if (status !== 'IN_PROGRESS') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ 
            error: 'Application must be in IN_PROGRESS status to upload documents.' 
          }),
        };
      }

      // Generate session
      const session_id = crypto.randomBytes(32).toString('hex');
      const expires_at = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

      // Save session
      await pool
        .request()
        .input('session_id', sql.VarChar(64), session_id)
        .input('student_id', sql.Int, student_id)
        .input('application_id', sql.Int, application_id)
        .input('expires_at', sql.DateTime2, expires_at)
        .query(`
          INSERT INTO application_sessions (session_id, student_id, application_id, expires_at)
          VALUES (@session_id, @student_id, @application_id, @expires_at)
        `);

      // Generate SAS URLs for 3 documents
      const upload_urls = {
        aadhaar: generateSASUrl(`${college_code}/${usn}/aadhaar`),
        college_id_card: generateSASUrl(`${college_code}/${usn}/college_id_card`),
        marks_card_10th: generateSASUrl(`${college_code}/${usn}/marks_card_10th`),
      };

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          session_id,
          upload_urls,
          expires_at: expires_at.toISOString(),
        }),
      };
    }

    // ===== ACTION: finalize_submission =====
    if (action === 'finalize_submission') {
      const { session_id } = body;

      if (!session_id) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Session ID is required' }),
        };
      }

      // Verify session
      const sessionResult = await pool
        .request()
        .input('session_id', sql.VarChar(64), session_id)
        .input('student_id', sql.Int, student_id)
        .query(`
          SELECT application_id, expires_at
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

      const { application_id, expires_at } = sessionResult.recordset[0];

      if (new Date() > new Date(expires_at)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Session has expired. Please restart the upload process.' }),
        };
      }

      // Get application details
      const appResult = await pool
        .request()
        .input('application_id', sql.Int, application_id)
        .query(`
          SELECT status, college_code
          FROM student_applications
          WHERE application_id = @application_id
        `);

      if (appResult.recordset.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Application not found' }),
        };
      }

      const { status, college_code } = appResult.recordset[0];

      if (status !== 'IN_PROGRESS') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Application is not in IN_PROGRESS status' }),
        };
      }

      // Check if all 3 documents exist in Azure Blob
      const aadhaarExists = await checkBlobExists(`${college_code}/${usn}/aadhaar`);
      const collegeIdExists = await checkBlobExists(`${college_code}/${usn}/college_id_card`);
      const marksCardExists = await checkBlobExists(`${college_code}/${usn}/marks_card_10th`);

      if (!aadhaarExists || !collegeIdExists || !marksCardExists) {
        const missing = [];
        if (!aadhaarExists) missing.push('Aadhaar Card');
        if (!collegeIdExists) missing.push('College ID Card');
        if (!marksCardExists) missing.push('10th Marks Card');

        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ 
            error: `Missing documents: ${missing.join(', ')}. Please upload all required documents.` 
          }),
        };
      }

      // Insert/update document records in application_documents
      const documentUrl = (docType) => 
        `https://${STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER_NAME}/${college_code}/${usn}/${docType}`;

      const documents = [
        { type: 'AADHAR', url: documentUrl('aadhaar') },
        { type: 'COLLEGE_ID', url: documentUrl('college_id_card') },
        { type: 'SSLC', url: documentUrl('marks_card_10th') },
      ];

      for (const doc of documents) {
        await pool
          .request()
          .input('application_id', sql.Int, application_id)
          .input('document_type', sql.VarChar(50), doc.type)
          .input('document_url', sql.VarChar(500), doc.url)
          .query(`
            IF EXISTS (
              SELECT 1 FROM application_documents 
              WHERE application_id = @application_id AND document_type = @document_type
            )
            BEGIN
              UPDATE application_documents
              SET document_url = @document_url, uploaded_at = SYSUTCDATETIME()
              WHERE application_id = @application_id AND document_type = @document_type
            END
            ELSE
            BEGIN
              INSERT INTO application_documents (application_id, document_type, document_url)
              VALUES (@application_id, @document_type, @document_url)
            END
          `);
      }

      // Update application status to SUBMITTED
      await pool
        .request()
        .input('application_id', sql.Int, application_id)
        .query(`
          UPDATE student_applications
          SET status = 'SUBMITTED', submitted_at = SYSUTCDATETIME()
          WHERE application_id = @application_id
        `);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'Application submitted successfully! Your application is now under review.' 
        }),
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid action' }),
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