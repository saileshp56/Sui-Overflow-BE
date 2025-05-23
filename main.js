const express = require('express');
const bodyParser = require('body-parser');
const { trainModel, predictWithModel } = require('./ml.js');

const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const cors = require('cors');
const path = require('path');
const { Tusky } = require('@tusky-io/ts-sdk');
const multer = require('multer'); // Import multer here

const app = express();
const port = 8080;

// Initialize Tusky client
var tuskyClient = null;
const initTuskyClient = async () => {
  const apiKey = process.env.TUSKY_API_KEY;

  if (!apiKey) {
    console.error('Missing Tusky API key in .env file');
    return null;
  }

  const client = new Tusky({ apiKey });
  return client;
};

// --- Multer Configuration ---
// Configure storage for temporary file for ALL file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`); // Add timestamp to avoid name conflicts
  }
});

// Configure file filter (accept CSV, JSON, or generic octet-stream for now)
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'text/csv' || file.mimetype === 'application/json' || file.mimetype === 'application/octet-stream') {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'), false);
  }
};

// Set up multer middleware instance
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});
// --- End Multer Configuration ---

// Middleware to parse JSON and URL-encoded request bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Add CORS middleware
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware to log all incoming requests
// app.use((req, res, next) => {
//   console.log('Request received:');
//   console.log('- Method:', req.method);
//   console.log('- Path:', req.path);
//   console.log('- Headers:', req.headers);

//   if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
//     console.log('- Body (multipart/form-data):', req.body);
//     if (req.file) {
//       console.log('- File (Multer):', req.file.originalname, req.file.mimetype, req.file.size);
//     } else if (req.files) {
//       console.log('- Files (Multer):', req.files);
//     }
//   } else if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
//     console.log('- Body (JSON):', req.body);
//   } else if (req.headers['content-type'] && req.headers['content-type'].includes('application/x-www-form-urlencoded')) {
//     console.log('- Body (URL-encoded):', req.body);
//   } else {
//     console.log('- Body (other/raw):', req.body instanceof Buffer ? req.body.toString() : req.body);
//   }
//   next();
// });

// --- /datasets route ---
app.post('/datasets', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    let metadata;
    try {
      metadata = JSON.parse(req.body.metadata);
    } catch (error) {
      console.error('Error parsing metadata:', error);
      return res.status(400).json({ success: false, message: 'Invalid metadata format' });
    }

    if (!tuskyClient) {
      tuskyClient = await initTuskyClient();
      if (!tuskyClient) {
        return res.status(500).json({ success: false, message: 'Tusky client not properly configured' });
      }
    }

    try {
      let vaultId = process.env.TUSKY_DATASETS_VAULT_ID;

      if (!vaultId) {
        const shouldEncrypt = process.env.TUSKY_USE_ENCRYPTION === 'true';

        if (shouldEncrypt) {
          const encryptionPassword = process.env.TUSKY_ENCRYPTION_PASSWORD;
          if (!encryptionPassword) {
            return res.status(500).json({
              success: false,
              message: 'Encryption password required to create encrypted vault. Set TUSKY_ENCRYPTION_PASSWORD in .env'
            });
          }
          console.log("ENCRYPTION PASSWORD", encryptionPassword)

          try {
            console.log('Importing encryption session...');
            const { keypair } = await tuskyClient.me.importEncryptionSessionFromPassword(encryptionPassword);
            console.log('Adding encrypter to Tusky client...');
            await tuskyClient.addEncrypter({ keypair });
            console.log('Encryption setup complete');
          } catch (importError) {
            console.error('Failed to import encryption session:', importError);
            try {
              console.log('Setting up password for encrypted vault...');
              const { keypair } = await tuskyClient.me.setupPassword(encryptionPassword);
              console.log('Adding encrypter to Tusky client...');
              await tuskyClient.addEncrypter({ keypair });
              console.log('Encryption setup complete');
            } catch (setupError) {
              console.error('Failed to set up password for encryption:', setupError);
              return res.status(500).json({
                success: false,
                message: `Failed to set up encryption: ${setupError.message}`
              });
            }
          }
        }

        console.log(`Creating a new ${shouldEncrypt ? 'private encrypted' : 'unencrypted'} Tusky vault for datasets...`);
        const vault = await tuskyClient.vault.create('Datasets Vault', { encrypted: shouldEncrypt });
        vaultId = vault.id;

        try {
          const envContent = fs.readFileSync('.env', 'utf8');
          const updatedContent = envContent +
            `\nTUSKY_DATASETS_VAULT_ID=${vaultId}` +
            `\nTUSKY_USE_ENCRYPTION=${shouldEncrypt}`;
          fs.writeFileSync('.env', updatedContent);
          console.log('Updated .env file with new vault ID and encryption setting');
        } catch (error) {
          console.error('Error updating .env file:', error);
        }
      } else {
        try {
          const vault = await tuskyClient.vault.get(vaultId);

          if (vault.encrypted) {
            const encryptionPassword = process.env.TUSKY_ENCRYPTION_PASSWORD;
            if (!encryptionPassword) {
              return res.status(500).json({
                success: false,
                message: 'Encryption password required for encrypted vault. Set TUSKY_ENCRYPTION_PASSWORD in .env'
              });
            }

            try {
              console.log('Importing encryption session for existing encrypted vault...');
              const { keypair } = await tuskyClient.me.importEncryptionSessionFromPassword(encryptionPassword);
              console.log('Adding encrypter to Tusky client...');
              await tuskyClient.addEncrypter({ keypair });
              console.log('Encryption setup complete');
            } catch (error) {
              console.error('Failed to import encryption session:', error);
              return res.status(500).json({
                success: false,
                message: `Failed to import encryption session: ${error.message}. Make sure you're using the correct password.`
              });
            }
          }

          console.log(`Using existing ${vault.encrypted ? 'encrypted' : 'unencrypted'} vault: ${vaultId}`);
        } catch (error) {
          console.error('Error checking vault encryption status:', error);
        }
      }

      console.log(`Uploading file to Tusky vault ${vaultId}...`);
      const uploadId = await tuskyClient.file.upload(vaultId, req.file.path);
      console.log(`File uploaded to Tusky with ID: ${uploadId}`);

      const fileMetadata = await tuskyClient.file.get(uploadId);

      // CREATE BONDING CURVE AND ADD IT AS A FIELD TO const dataset

      const dataset = {
        title: metadata.title,
        description: metadata.description,
        format: metadata.format,
        categories: metadata.categories,
        size: req.file.size,
        chain_id: 102,
        tusky_file_id: uploadId,
        tusky_blob_id: fileMetadata.blobId,
        tusky_object_id: fileMetadata.blobObjectId,
        original_filename: req.file.originalname,
        upload_date: new Date().toISOString()
      };

      console.log('New dataset:', dataset);

      try {
        if (!fs.existsSync(path.join(__dirname, 'data'))) {
          fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
        }

        let datasets = { datasets: [] };
        const datasetsPath = path.join(__dirname, 'data', 'datasets.json');

        if (fs.existsSync(datasetsPath)) {
          const datasetsJson = fs.readFileSync(datasetsPath, 'utf8');
          datasets = JSON.parse(datasetsJson);
        }

        datasets.datasets.push(dataset);
        fs.writeFileSync(datasetsPath, JSON.stringify(datasets, null, 2));
        console.log('Dataset saved to datasets.json');

        try {
          let bondingCurves = { curves: {} };
          const bondingCurvesPath = path.join(__dirname, 'data', 'bonding_curves.json');

          if (fs.existsSync(bondingCurvesPath)) {
            const bondingCurvesJson = fs.readFileSync(bondingCurvesPath, 'utf8');
            bondingCurves = JSON.parse(bondingCurvesJson);
          }

          bondingCurves.curves[dataset.title] = {
            address: "",
            name: `${dataset.title} Token`,
            symbol: `${dataset.title.substring(0, 3).toUpperCase()}`,
            chain_id: 102
          };

          fs.writeFileSync(bondingCurvesPath, JSON.stringify(bondingCurves, null, 2));
          console.log('Bonding curve saved to bonding_curves.json');
        } catch (error) {
          console.error('Error saving to bonding_curves.json:', error);
        }
      } catch (error) {
        console.error('Error saving dataset to datasets.json:', error);
      }

      try {
        fs.unlinkSync(req.file.path);
      } catch (error) {
        console.error('Error deleting temporary file:', error);
      }

      res.status(201).json({
        success: true,
        message: 'Dataset uploaded successfully to Tusky',
        dataset: {
          id: dataset.tusky_file_id,
          title: dataset.title,
          upload_date: dataset.upload_date
        }
      });
    } catch (error) {
      console.error('Error uploading to Tusky:', error);
      return res.status(500).json({
        success: false,
        message: `Error uploading to Tusky: ${error.message}`
      });
    }
  } catch (error) {
    console.error('Server error in /datasets:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});

// --- /datasets endpoint ---
app.get('/datasets', (req, res) => {
  try {
    let datasets;
    try {
      const datasetsJson = fs.readFileSync("data/datasets.json", 'utf8');
      datasets = JSON.parse(datasetsJson);
    } catch (err) {
      console.error("Failed to read datasets.json:", err);
      return res.status(500).json({ error: "Failed to read datasets.json" });
    }

    let bondingCurves = { curves: {} };
    try {
      const bondingCurvesJson = fs.readFileSync("data/bonding_curves.json", 'utf8');
      bondingCurves = JSON.parse(bondingCurvesJson);
    } catch (err) {
      console.error("Failed to read bonding_curves.json:", err);
    }

    const datasetsWithCurves = datasets.datasets.map(dataset => {
      const bondingCurve = bondingCurves.curves[dataset.title];
      return {
        ...dataset,
        bonding_curve: bondingCurve || null
      };
    });

    res.json({ datasets: datasetsWithCurves });
  } catch (error) {
    console.error('Error in get_datasets:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- /get_file route ---
app.post('/get_file', upload.single('validation_dataset'), async (req, res) => {
  try {
    let { title, desired_accuracy, maxDepth, minSamplesLeaf, minSamplesSplit, criterion, testData } = req.body;
    const validationFile = req.file;

    // This line overrides the 'title' parameter from the request body.
    // If you intend to use the title sent from the frontend, remove or adjust this line.
    title = "sp";

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Missing title parameter. Ensure it is in the request body.'
      });
    }

    let datasets;
    try {
      const datasetsPath = path.join(__dirname, 'data', 'datasets.json');
      if (!fs.existsSync(datasetsPath)) {
        return res.status(404).json({
          success: false,
          message: 'No datasets found. Upload a dataset first.'
        });
      }

      const datasetsJson = fs.readFileSync(datasetsPath, 'utf8');
      datasets = JSON.parse(datasetsJson);
    } catch (err) {
      console.error("Failed to read datasets.json:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to read datasets.json"
      });
    }

    const dataset = datasets.datasets.find(ds => ds.title === title);

    if (!dataset) {
      return res.status(404).json({
        success: false,
        message: `Dataset with title "${title}" not found`
      });
    }

    const fileId = dataset.tusky_file_id;

    if (!fileId) {
      return res.status(404).json({
        success: false,
        message: `No file ID found for dataset "${title}"`
      });
    }

    if (false) { // used to be !tuskyClient spolav
      tuskyClient = await initTuskyClient();
      if (!tuskyClient) {
        return res.status(500).json({
          success: false,
          message: 'Tusky client not properly configured'
        });
      }

      const encryptionPassword = process.env.TUSKY_ENCRYPTION_PASSWORD;
      if (encryptionPassword) {
        try {
          const { keypair } = await tuskyClient.me.importEncryptionSessionFromPassword(encryptionPassword);
          await tuskyClient.addEncrypter({ keypair });
        } catch (error) {
          console.error('Failed to set up encryption:', error);
        }
      }
    }

    console.log(`Getting file buffer for dataset "${title}" with ID: ${fileId}...`);
    const fileBuffer = await tuskyClient.file.arrayBuffer(fileId);
    console.log(`Successfully retrieved file buffer (${fileBuffer.byteLength} bytes)`);

    const trainingsetDir = path.join(__dirname, 'data', 'trainingsets');
    if (!fs.existsSync(trainingsetDir)) {
      fs.mkdirSync(trainingsetDir, { recursive: true });
    }

    const fileName = `${fileId}.csv`;
    const filePath = path.join(trainingsetDir, fileName);

    fs.writeFileSync(filePath, Buffer.from(fileBuffer));
    console.log(`File saved to: ${filePath}`);

    const modelInfo = await trainModel(fileId, maxDepth, minSamplesLeaf, minSamplesSplit, criterion);

    let predictions = null;

    console.log("OK TEST DATA TIME", testData);
    if (testData) {
      try {
        const testDataObj = JSON.parse(testData);

        try {
          predictions = predictWithModel(fileId, testDataObj);
          console.log("PREDICTIONS", predictions)
        } catch (predError) {
          console.error('Error making predictions:', predError);
          predictions = {
            error: predError.message
          };
        }
      } catch (parseError) {
        console.error('Error parsing test data:', parseError);
        predictions = {
          error: 'Invalid test data format. Must be a valid JSON string.'
        };
      }
    }

    let good_prediction = predictions >= desired_accuracy;
    if (good_prediction) {
      const response = {
        success: true,
        message: `File saved and model trained successfully`,
        dataset: {
          title: dataset.title,
          fileName: fileName,
          filePath: filePath,
          size: fileBuffer.byteLength
        },
        model: modelInfo,
        good_prediction:  good_prediction
      };
  
      if (predictions) {
        response.predictions = predictions;
      }

      // BUY THE BONDING CURVE
  
      res.json(response);
    } else {
      let resppp = {
        success: false
      }

      res.json(resppp)
    }
    
  } catch (error) {
    console.error('Error in get_file:', error);
    res.status(500).json({
      success: false,
      message: `Error getting file: ${error.message}`
    });
  } finally {
    // If a validation file was uploaded via Multer, delete its temporary copy
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
        console.log('Temporary validation file deleted:', req.file.path);
      } catch (unlinkErr) {
        console.error('Error deleting temporary validation file:', unlinkErr);
      }
    }
  }
});

// Start the server
app.listen(port, async () => {
  console.log(`RISC0 Proof verification server running on port ${port}`);
  console.log(`POST to /verify with {"receiptPath": "/path/to/receipt.json"} to verify a proof`);

  tuskyClient = await initTuskyClient();
  if (true) {
    const encryptionPassword = process.env.TUSKY_ENCRYPTION_PASSWORD;
    if (encryptionPassword) {
      try {
        const { keypair } = await tuskyClient.me.importEncryptionSessionFromPassword(encryptionPassword);
        await tuskyClient.addEncrypter({ keypair });
      } catch (error) {
        console.error('Failed to set up encryption:', error);
      }
    }
  }

  if (tuskyClient) {
    console.log('Tusky client initialized successfully');

    const vaultId = process.env.TUSKY_DATASETS_VAULT_ID;
    if (vaultId) {
      console.log(`Using existing Tusky vault: ${vaultId}`);
      try {
        const vault = await tuskyClient.vault.get(vaultId);

        if (vault.encrypted) {
          const encryptionPassword = process.env.TUSKY_ENCRYPTION_PASSWORD;
          if (encryptionPassword) {
            try {
              console.log('Importing encryption session for existing encrypted vault...');
              const { keypair } = await tuskyClient.me.importEncryptionSessionFromPassword(encryptionPassword);
              await tuskyClient.addEncrypter({ keypair });
              console.log('Encryption setup complete');
            } catch (error) {
              console.error('Failed to import encryption session:', error);
              console.log('IMPORTANT: You must provide the correct encryption password to access encrypted files.');
              console.log('If you don\'t know the password, remove TUSKY_DATASETS_VAULT_ID from .env to create a new vault.');
            }
          } else {
            console.warn('Encrypted vault detected but no TUSKY_ENCRYPTION_PASSWORD provided in .env');
          }
        }
      } catch (error) {
        console.error('Error checking vault encryption status:', error);
      }
    } else {
      console.log('No Tusky vault ID found. One will be created on first upload.');
    }
  } else {
    console.error('Failed to initialize Tusky client. Please check your .env configuration.');
  }
});