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

const { SuiClient, getFullnodeUrl } = require('@mysten/sui/client');
const { Transaction } = require('@mysten/sui/transactions');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { decodeSuiPrivateKey } = require('@mysten/sui/cryptography');

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

// Constants from Move contract
const PRECISION_FOR_PRICE = 1000000; // 1_000_000
const INITIAL_PRICE_SCALED = 100;
const PRICE_INCREASE_SCALED = 10;

// Helper function to get Sui Client and Keypair
async function getSuiClientAndKeypair() {
  const suiPackageId = process.env.SUI_PACKAGE_ID;
  const exportedPrivateKey = process.env.SUI_EXPORTED_PRIVATE_KEY;
  const recoveryPhrase = process.env.SUI_RECOVERY_PHRASE;

  if (!suiPackageId) {
    console.error('SUI_PACKAGE_ID is not set in .env file.');
    throw new Error('Sui package ID configuration is missing.');
  }

  if (!exportedPrivateKey && !recoveryPhrase) {
    console.error('Neither SUI_EXPORTED_PRIVATE_KEY nor SUI_RECOVERY_PHRASE is set in .env file.');
    throw new Error('Sui key material configuration is missing.');
  }

  const suiRpcUrl = getFullnodeUrl('testnet');
  const suiClient = new SuiClient({ url: suiRpcUrl });

  let keypair;
  try {
    if (exportedPrivateKey) {
      if (!exportedPrivateKey.startsWith('suiprivkey')) {
        throw new Error('SUI_EXPORTED_PRIVATE_KEY does not appear to be a valid suiprivkey string.');
      }
      const { secretKey } = decodeSuiPrivateKey(exportedPrivateKey);
      keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else if (recoveryPhrase) {
      keypair = Ed25519Keypair.fromMnemonic(recoveryPhrase);
    } else {
        throw new Error('No valid key material found.');
    }
  } catch (err) {
    console.error('Failed to create keypair:', err);
    throw new Error(`Invalid SUI key material: ${err.message}`);
  }
  
  // console.log(`Using sender address for transaction: ${keypair.getPublicKey().toSuiAddress()}`);
  return { suiClient, keypair };
}

async function createBondingCurveOnSui(initialCurveId) {
  const suiPackageId = process.env.SUI_PACKAGE_ID;
  const { suiClient, keypair } = await getSuiClientAndKeypair();
  console.log(`Using sender address for createBondingCurveOnSui: ${keypair.getPublicKey().toSuiAddress()}`);

  const txb = new Transaction();
  txb.moveCall({
    target: `${suiPackageId}::bonding_curve_module::create_new_curve`,
    arguments: [
      txb.pure.u64(initialCurveId.toString()) // initial_curve_id: u64
    ],
  });

  try {
    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: txb,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    let newCurveObjectId = null;
    const expectedEventType = `${suiPackageId}::bonding_curve_module::NewCurveCreated`;
    if (result.events) {
      for (const event of result.events) {
        if (event.type === expectedEventType) {
          newCurveObjectId = event.parsedJson.new_curve_object_id;
          console.log(`Found NewCurveCreated event, new_curve_object_id: ${newCurveObjectId}`);
          break;
        }
      }
    }

    if (!newCurveObjectId && result.effects && result.effects.created) {
      console.log('NewCurveCreated event not found or did not contain ID, checking created objects...');
      const expectedObjectType = `${suiPackageId}::bonding_curve_module::BondingCurve`;
      for (const createdObj of result.effects.created) {
        if (createdObj.objectType === expectedObjectType) {
          newCurveObjectId = createdObj.reference.objectId;
          console.log(`Found created object of type ${expectedObjectType}, objectId: ${newCurveObjectId}`);
          break;
        }
      }
    }

    if (!newCurveObjectId) {
      console.error('Could not find new_curve_object_id in transaction effects or events.');
      console.error('Sui transaction result:', JSON.stringify(result, null, 2));
      throw new Error('Failed to extract new curve object ID from Sui transaction.');
    }
    
    console.log(`New bonding curve created on Sui with Object ID: ${newCurveObjectId}`);
    return {
      new_curve_object_id: newCurveObjectId,
      package_id: suiPackageId,
      transaction_digest: result.digest,
    };
  } catch (error) {
    console.error('Error creating bonding curve on Sui:', error.message);
    if (error.cause) console.error('Cause:', error.cause);
    // For more detailed Sui errors, you might need to inspect error.message or specific fields if available
    throw error;
  }
}

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
      let bondingCurveInfoSui;
      let curveIdForSui = Date.now(); // Using timestamp as a unique u64 ID

      try {
        bondingCurveInfoSui = await createBondingCurveOnSui(curveIdForSui);
        console.log('Bonding curve successfully created on Sui:', bondingCurveInfoSui);
      } catch (suiError) {
        console.error('Failed to create bonding curve on Sui during dataset upload:', suiError.message);
      }

      const dataset = {
        title: metadata.title,
        description: metadata.description,
        format: metadata.format,
        categories: metadata.categories,
        size: req.file.size,
        chain_id: bondingCurveInfoSui ? "sui:testnet" : 102, // Update chain_id if Sui curve created
        tusky_file_id: uploadId,
        tusky_blob_id: fileMetadata.blobId,
        tusky_object_id: fileMetadata.blobObjectId,
        original_filename: req.file.originalname,
        upload_date: new Date().toISOString(),
        sui_bonding_curve: bondingCurveInfoSui ? {
            object_id: bondingCurveInfoSui.new_curve_object_id,
            package_id: bondingCurveInfoSui.package_id,
            shared_treasury_provider_id: process.env.SUI_SHARED_TREASURY_PROVIDER_ID, // Store this for buy/sell
            initial_curve_id_used: curveIdForSui,
            transaction_digest: bondingCurveInfoSui.transaction_digest
        } : null
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
            address: bondingCurveInfoSui ? bondingCurveInfoSui.new_curve_object_id : "NOT_CREATED_ON_SUI",
            name: `${dataset.title} Token`,
            symbol: `${dataset.title.substring(0, 3).toUpperCase()}`, // This might change based on actual token metadata from Sui if available
            chain_id: bondingCurveInfoSui ? "sui:testnet" : 102, // Standardized chain identifier
            sui_package_id: bondingCurveInfoSui ? bondingCurveInfoSui.package_id : null,
            sui_shared_treasury_provider_id: bondingCurveInfoSui ? process.env.SUI_SHARED_TREASURY_PROVIDER_ID : null,
          };

          fs.writeFileSync(bondingCurvesPath, JSON.stringify(bondingCurves, null, 2));
          console.log('Bonding curve info updated in bonding_curves.json');
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
app.get('/datasets', async (req, res) => {
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

    const datasetsWithCurvesAndPrices = await Promise.all(datasets.datasets.map(async dataset => {
      const bondingCurve = bondingCurves.curves[dataset.title];
      let price = null;
      
      if (dataset.sui_bonding_curve && dataset.sui_bonding_curve.object_id) {
        try {
          const scaledPrice = await exampleGetCurvePrice(dataset.sui_bonding_curve.object_id);
          // Convert scaled price to SUI by dividing by PRECISION_FOR_PRICE
          price = scaledPrice ? Number(scaledPrice.toString()) / Number(PRECISION_FOR_PRICE) : null;

        } catch (error) {
          console.error(`Failed to get price for dataset ${dataset.title}:`, error);
        }
      }

      return {
        ...dataset,
        bonding_curve: bondingCurve || null,
        current_price: price ? {
          amount: price,
          currency: "SUI"
        } : null
      };
    }));

    res.json({ datasets: datasetsWithCurvesAndPrices });
  } catch (error) {
    console.error('Error in get_datasets:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- /get_file route ---
app.post('/get_file', upload.single('validation_dataset'), async (req, res) => {
  console.log("GET FILE POSTINGGG");
  try {
    let { title, desired_accuracy, maxDepth, minSamplesLeaf, minSamplesSplit, criterion, testData } = req.body;
    const validationFile = req.file;

    // This line overrides the 'title' parameter from the request body.
    // If you intend to use the title sent from the frontend, remove or adjust this line.

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
      try {
        // Get the bonding curve object ID from the dataset
        if (dataset.sui_bonding_curve && dataset.sui_bonding_curve.object_id) {
          const buyResult = await suiBuyTokens(dataset.sui_bonding_curve.object_id, 5);
          response.bonding_curve_purchase = {
            success: true,
            transaction_digest: buyResult.transaction_digest,
            purchased_event_details: buyResult.purchased_event_details
          };
        } else {
          console.warn('No bonding curve object ID found for dataset ->', dataset);
          response.bonding_curve_purchase = {
            success: false,
            message: 'No bonding curve object ID found for dataset'
          };
        }
      } catch (buyError) {
        console.error('Error buying from bonding curve:', buyError);
        response.bonding_curve_purchase = {
          success: false,
          error: buyError.message
        };
      }

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

async function exampleGetCurvePrice(someBondingCurveObjectId) {
  try {
    console.log(`Fetching state for curve: ${someBondingCurveObjectId}`);
    const curveState = await getBondingCurveState(someBondingCurveObjectId);
    
    console.log(`Total supply for pricing: ${curveState.total_supply_for_pricing.toString()}`);
    console.log(`Curve ID from state: ${curveState.curve_id.toString()}`);

    // "Calling" the current_price_scaled view function:
    const currentPrice = jsCurrentPriceScaled(curveState.total_supply_for_pricing);
    console.log(`Calculated current price (scaled) for ${someBondingCurveObjectId}: ${currentPrice.toString()}`);

    // "Calling" total_supply_for_pricing and get_curve_id (getters):
    const totalSupply = curveState.total_supply_for_pricing; // Already fetched
    const curveId = curveState.curve_id; // Already fetched
    console.log(`Getter - Total Supply: ${totalSupply.toString()}`);
    console.log(`Getter - Curve ID: ${curveId.toString()}`);
    
    // "Calling" calculate_purchase_amount:
    const mockPayment = 100000n; // Example mock payment (as BigInt)
    const tokensToGet = jsCalculatePurchaseAmount(curveState.total_supply_for_pricing, mockPayment);
    console.log(`For a mock payment of ${mockPayment.toString()}, you would get ${tokensToGet.toString()} tokens.`);

    return BigInt(currentPrice); // Return as BigInt
  } catch (error) {
    console.error(`Error in exampleGetCurvePrice for ${someBondingCurveObjectId}:`, error.message);
    // Handle error appropriately
    return null;
  }
}


// Function to buy tokens from a specific bonding curve
async function suiBuyTokens(bondingCurveObjectId, mockPaymentAmount) {
  const suiPackageId = process.env.SUI_PACKAGE_ID;
  const sharedTreasuryProviderId = process.env.SUI_SHARED_TREASURY_PROVIDER_ID;

  if (!sharedTreasuryProviderId) {
    console.error('SUI_SHARED_TREASURY_PROVIDER_ID is not set in .env file.');
    throw new Error('Sui Shared Treasury Provider ID configuration is missing.');
  }

  if (!bondingCurveObjectId) {
    throw new Error('Bonding curve object ID is required.');
  }
  if (mockPaymentAmount <= 0) {
    throw new Error('Mock payment amount must be greater than zero.');
  }

  const { suiClient, keypair } = await getSuiClientAndKeypair();
  console.log(`Using sender address for suiBuyTokens: ${keypair.getPublicKey().toSuiAddress()}`);

  const txb = new Transaction();
  txb.moveCall({
    target: `${suiPackageId}::bonding_curve_module::buy`,
    arguments: [
      txb.object(sharedTreasuryProviderId), // treasury_provider: &mut SharedTreasuryProvider
      txb.object(bondingCurveObjectId),    // curve: &mut BondingCurve
      txb.pure.u64(mockPaymentAmount.toString()), // mock_payment_amount: u64
    ],
  });

  try {
    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: txb,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });

    let purchasedEvent = null;
    const expectedEventType = `${suiPackageId}::bonding_curve_module::TokenPurchased`;
    if (result.events) {
      for (const event of result.events) {
        if (event.type === expectedEventType && event.parsedJson && event.parsedJson.curve_id === (await getBondingCurveDetailsFromSui(bondingCurveObjectId, suiClient)).curve_id.toString()) {
          // We also need to ensure this event is for the correct curve object if multiple curves exist
          // This check assumes getBondingCurveDetailsFromSui fetches the curve and matches its internal curve_id
          // For now, we simplify and assume the event on this tx for this module is the one we want if the target object matches.
          // A more robust check might involve inspecting object changes if the event doesn't uniquely identify the curve instance.
          purchasedEvent = event.parsedJson;
          console.log(`Found TokenPurchased event:`, purchasedEvent);
          break;
        }
      }
    }

    if (!purchasedEvent) {
      console.warn('TokenPurchased event not found or did not match expected curve ID. Transaction result:', JSON.stringify(result, null, 2));
      // Fallback or less precise: check if the transaction was successful and a coin was transferred to the buyer
      if (result.effects.status.status !== 'success') {
        throw new Error(`Sui transaction failed: ${result.effects.status.error}`);
      }
      // This part is tricky without a clear way to get the minted coin ID from the buy event directly for non-owned objects
      // The event is the primary confirmation here.
      console.log('Transaction successful, but specific TokenPurchased event details not fully confirmed from events alone for this curve instance.');
    }
    
    console.log(`Tokens purchased successfully. Transaction digest: ${result.digest}`);
    return {
      transaction_digest: result.digest,
      events: result.events,
      effects: result.effects,
      purchased_event_details: purchasedEvent, // May be null if specific event not found
    };
  } catch (error) {
    console.error('Error buying tokens on Sui:', error.message);
    if (error.cause) console.error('Cause:', error.cause);
    throw error;
  }
}

// --- Bonding Curve Routes ---
app.post('/bonding-curve/buy', async (req, res) => {
  const { bondingCurveObjectId, mockPaymentAmount } = req.body;

  if (!bondingCurveObjectId || typeof mockPaymentAmount !== 'number' || mockPaymentAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Missing or invalid parameters: bondingCurveObjectId (string) and mockPaymentAmount (positive number) are required.'
    });
  }

  try {
    const result = await suiBuyTokens(bondingCurveObjectId, mockPaymentAmount);
    res.status(200).json({ success: true, message: 'Buy transaction submitted successfully.', data: result });
  } catch (error) {
    console.error('Error in /bonding-curve/buy route:', error.message);
    res.status(500).json({
      success: false,
      message: `Error buying tokens: ${error.message}`
    });
  }
});

// Function to fetch BondingCurve object details from Sui
// This will be used by view functions and potentially by buy/sell for confirmations
async function getBondingCurveDetailsFromSui(bondingCurveObjectId, client) {
  let suiClient = client;
  if (!suiClient) {
    const { suiClient: newClient } = await getSuiClientAndKeypair();
    suiClient = newClient;
  }
  try {
    const objectResponse = await suiClient.getObject({
      id: bondingCurveObjectId,
      options: { showContent: true },
    });

    if (objectResponse.error || !objectResponse.data || !objectResponse.data.content) {
      console.error('Error fetching bonding curve object or object has no content:', objectResponse.error);
      throw new Error(`Failed to fetch bonding curve object ${bondingCurveObjectId}: ${objectResponse.error?.message || 'No data or content'}`);
    }
    
    // Assuming the content is of type `0xPACKAGE::bonding_curve_module::BondingCurve`
    // and fields are `total_supply_for_pricing` and `curve_id` (as u64 strings)
    const fields = objectResponse.data.content.fields;
    return {
      total_supply_for_pricing: BigInt(fields.total_supply_for_pricing),
      curve_id: BigInt(fields.curve_id),
      // raw_object: objectResponse.data // uncomment if you need the full object
    };
  } catch (error) {
    console.error(`Error getting bonding curve details for ${bondingCurveObjectId}:`, error.message);
    throw error;
  }
}

// Function to sell tokens to a specific bonding curve
async function suiSellTokens(bondingCurveObjectId, tokenCoinObjectId) {
  const suiPackageId = process.env.SUI_PACKAGE_ID;
  const sharedTreasuryProviderId = process.env.SUI_SHARED_TREASURY_PROVIDER_ID;

  if (!sharedTreasuryProviderId) {
    console.error('SUI_SHARED_TREASURY_PROVIDER_ID is not set in .env file.');
    throw new Error('Sui Shared Treasury Provider ID configuration is missing.');
  }
  if (!bondingCurveObjectId) {
    throw new Error('Bonding curve object ID is required.');
  }
  if (!tokenCoinObjectId) {
    throw new Error('Token coin object ID to sell is required.');
  }

  const { suiClient, keypair } = await getSuiClientAndKeypair();
  console.log(`Using sender address for suiSellTokens: ${keypair.getPublicKey().toSuiAddress()}`);

  const txb = new Transaction();
  txb.moveCall({
    target: `${suiPackageId}::bonding_curve_module::sell`,
    arguments: [
      txb.object(sharedTreasuryProviderId), // treasury_provider: &mut SharedTreasuryProvider
      txb.object(bondingCurveObjectId),    // curve: &mut BondingCurve
      txb.object(tokenCoinObjectId),       // tokens_to_sell: Coin<BONDING_CURVE_MODULE>
    ],
  });

  try {
    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: txb,
      options: { showEffects: true, showEvents: true },
    });

    let soldEvent = null;
    const expectedEventType = `${suiPackageId}::bonding_curve_module::TokenSold`;
    if (result.events) {
      for (const event of result.events) {
        if (event.type === expectedEventType) {
          // Similar to buy, a more robust check might be needed if multiple curves exist
          // and events don't uniquely identify the curve instance via the event fields alone.
          soldEvent = event.parsedJson;
          console.log(`Found TokenSold event:`, soldEvent);
          break;
        }
      }
    }

    if (!soldEvent && result.effects.status.status !== 'success') {
        throw new Error(`Sui transaction failed: ${result.effects.status.error}`);
    }
    if (!soldEvent){
        console.warn('TokenSold event not found. Transaction was successful but event details are missing.', JSON.stringify(result, null, 2));
    }
    
    console.log(`Tokens sold successfully. Transaction digest: ${result.digest}`);
    return {
      transaction_digest: result.digest,
      events: result.events,
      effects: result.effects,
      sold_event_details: soldEvent, // May be null if specific event not found
    };
  } catch (error) {
    console.error('Error selling tokens on Sui:', error.message);
    if (error.cause) console.error('Cause:', error.cause);
    throw error;
  }
}

app.post('/bonding-curve/sell', async (req, res) => {
  const { bondingCurveObjectId, tokenCoinObjectId } = req.body;

  if (!bondingCurveObjectId || !tokenCoinObjectId) {
    return res.status(400).json({
      success: false,
      message: 'Missing or invalid parameters: bondingCurveObjectId (string) and tokenCoinObjectId (string) are required.'
    });
  }

  try {
    const result = await suiSellTokens(bondingCurveObjectId, tokenCoinObjectId);
    res.status(200).json({ success: true, message: 'Sell transaction submitted successfully.', data: result });
  } catch (error) {
    console.error('Error in /bonding-curve/sell route:', error.message);
    res.status(500).json({
      success: false,
      message: `Error selling tokens: ${error.message}`
    });
  }
});

// --- Client-side Calculation Helpers (mirroring Move logic) ---
function calculateCurrentPriceScaled(totalSupplyForPricing) {
  return BigInt(INITIAL_PRICE_SCALED) + (BigInt(totalSupplyForPricing) * BigInt(PRICE_INCREASE_SCALED));
}

function calculatePurchaseAmountForTokens(totalSupplyForPricing, mockPaymentAmount) {
  const price = calculateCurrentPriceScaled(totalSupplyForPricing);
  if (price === 0n) { return 0n; }
  return (BigInt(mockPaymentAmount) * BigInt(PRECISION_FOR_PRICE)) / price;
}

function calculatePaymentRequiredForTokens(totalSupplyForPricing, tokenAmount) {
  const price = calculateCurrentPriceScaled(totalSupplyForPricing);
  return (BigInt(tokenAmount) * price) / BigInt(PRECISION_FOR_PRICE);
}

function calculateSaleReturnForTokens(totalSupplyForPricing, tokenAmountToSell) {
  totalSupplyForPricing = BigInt(totalSupplyForPricing);
  tokenAmountToSell = BigInt(tokenAmountToSell);
  if (totalSupplyForPricing < tokenAmountToSell) {
    // This should ideally align with E_INSUFFICIENT_SUPPLY_FOR_SALE from Move
    // For client-side calc, we can return 0 or throw an error.
    // Throwing error might be better to indicate impossibility.
    throw new Error('Insufficient supply for the sale (total_supply_for_pricing < tokenAmountToSell).');
  }
  const supplyAfterSale = totalSupplyForPricing - tokenAmountToSell;
  const priceAtSaleTime = BigInt(INITIAL_PRICE_SCALED) + (supplyAfterSale * BigInt(PRICE_INCREASE_SCALED));
  return (tokenAmountToSell * priceAtSaleTime) / BigInt(PRECISION_FOR_PRICE);
}

// --- Bonding Curve View Function Routes ---

app.get('/bonding-curve/:curveObjectId/info', async (req, res) => {
  const { curveObjectId } = req.params;
  try {
    const details = await getBondingCurveDetailsFromSui(curveObjectId);
    res.status(200).json({ 
      success: true, 
      data: {
        ...details,
        total_supply_for_pricing: details.total_supply_for_pricing.toString(),
        curve_id: details.curve_id.toString(),
      }
    });
  } catch (error) {
    console.error(`Error in /bonding-curve/${curveObjectId}/info route:`, error.message);
    res.status(500).json({ success: false, message: `Error fetching curve info: ${error.message}` });
  }
});

app.get('/bonding-curve/:curveObjectId/current-price-scaled', async (req, res) => {
  const { curveObjectId } = req.params;
  try {
    const { total_supply_for_pricing } = await getBondingCurveDetailsFromSui(curveObjectId);
    const currentPrice = calculateCurrentPriceScaled(total_supply_for_pricing);
    res.status(200).json({ success: true, data: { current_price_scaled: currentPrice.toString() } });
  } catch (error) {
    console.error(`Error in /bonding-curve/${curveObjectId}/current-price-scaled route:`, error.message);
    res.status(500).json({ success: false, message: `Error calculating current price: ${error.message}` });
  }
});

app.get('/bonding-curve/:curveObjectId/calculate-purchase-amount', async (req, res) => {
  const { curveObjectId } = req.params;
  const mockPaymentAmount = req.query.mockPaymentAmount;

  if (mockPaymentAmount === undefined || isNaN(Number(mockPaymentAmount)) || Number(mockPaymentAmount) <= 0) {
    return res.status(400).json({ success: false, message: 'Missing or invalid query parameter: mockPaymentAmount (positive number) is required.' });
  }

  try {
    const { total_supply_for_pricing } = await getBondingCurveDetailsFromSui(curveObjectId);
    const tokenAmount = calculatePurchaseAmountForTokens(total_supply_for_pricing, BigInt(mockPaymentAmount));
    res.status(200).json({ success: true, data: { token_amount: tokenAmount.toString() } });
  } catch (error) {
    console.error(`Error in /bonding-curve/${curveObjectId}/calculate-purchase-amount route:`, error.message);
    res.status(500).json({ success: false, message: `Error calculating purchase amount: ${error.message}` });
  }
});

app.get('/bonding-curve/:curveObjectId/calculate-payment-required', async (req, res) => {
  const { curveObjectId } = req.params;
  const tokenAmount = req.query.tokenAmount;

  if (tokenAmount === undefined || isNaN(Number(tokenAmount)) || Number(tokenAmount) <= 0) {
    return res.status(400).json({ success: false, message: 'Missing or invalid query parameter: tokenAmount (positive number) is required.' });
  }

  try {
    const { total_supply_for_pricing } = await getBondingCurveDetailsFromSui(curveObjectId);
    const paymentRequired = calculatePaymentRequiredForTokens(total_supply_for_pricing, BigInt(tokenAmount));
    res.status(200).json({ success: true, data: { payment_required: paymentRequired.toString() } });
  } catch (error) {
    console.error(`Error in /bonding-curve/${curveObjectId}/calculate-payment-required route:`, error.message);
    res.status(500).json({ success: false, message: `Error calculating payment required: ${error.message}` });
  }
});

app.get('/bonding-curve/:curveObjectId/calculate-sale-return', async (req, res) => {
  const { curveObjectId } = req.params;
  const tokenAmountToSell = req.query.tokenAmountToSell;

  if (tokenAmountToSell === undefined || isNaN(Number(tokenAmountToSell)) || Number(tokenAmountToSell) <= 0) {
    return res.status(400).json({ success: false, message: 'Missing or invalid query parameter: tokenAmountToSell (positive number) is required.' });
  }

  try {
    const { total_supply_for_pricing } = await getBondingCurveDetailsFromSui(curveObjectId);
    const saleReturn = calculateSaleReturnForTokens(total_supply_for_pricing, BigInt(tokenAmountToSell));
    res.status(200).json({ success: true, data: { sale_return: saleReturn.toString() } });
  } catch (error) {
    console.error(`Error in /bonding-curve/${curveObjectId}/calculate-sale-return route:`, error.message);
    // Distinguish between calculation error (like insufficient supply) and other errors
    if (error.message.includes('Insufficient supply')) {
        return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: `Error calculating sale return: ${error.message}` });
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


/**
 * Fetches the state of a BondingCurve object from the Sui network.
 * @param {string} bondingCurveObjectId The ID of the BondingCurve shared object.
 * @param {SuiClient} client Optional SuiClient instance.
 * @param {number} retries Optional number of retries for fetching.
 * @param {number} delayMs Optional delay between retries.
 * @returns {Promise<object>} An object with total_supply_for_pricing and curve_id.
 */
async function getBondingCurveState(bondingCurveObjectId, client, retries = 3, delayMs = 1000) {
  let suiClient = client;
  if (!suiClient) {
    // Get a client instance if one isn't provided
    const { suiClient: newClient } = await getSuiClientAndKeypair();
    suiClient = newClient;
  }

  try {
    const objectResponse = await suiClient.getObject({
      id: bondingCurveObjectId,
      options: { showContent: true }, // Only content is needed for these fields
    });

    if (objectResponse.error) {
      if (objectResponse.error.code === 'notExists' && retries > 0) {
        console.warn(`BondingCurve object ${bondingCurveObjectId} not found, retrying (${retries} left) in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return getBondingCurveState(bondingCurveObjectId, suiClient, retries - 1, delayMs);
      }
      console.error('Error fetching bonding curve object:', objectResponse.error);
      throw new Error(`Failed to fetch bonding curve object ${bondingCurveObjectId}: ${objectResponse.error?.message || 'Unknown error'}`);
    }

    if (!objectResponse.data || !objectResponse.data.content || !objectResponse.data.content.fields) {
      console.error('Bonding curve object has no data, content, or fields:', objectResponse);
      throw new Error(`Bonding curve object ${bondingCurveObjectId} has no data, content, or fields`);
    }

    const fields = objectResponse.data.content.fields;
    return {
      total_supply_for_pricing: BigInt(fields.total_supply_for_pricing),
      curve_id: BigInt(fields.curve_id),
    };
  } catch (error) {
    console.error(`Error getting bonding curve state for ${bondingCurveObjectId}:`, error.message);
    throw error; // Re-throw the error to be handled by the caller
  }
}

function jsCurrentPriceScaled(totalSupplyForPricing) {
  // Convert constants to BigInt and ensure all operations use BigInt
  const initialPriceScaled = BigInt(INITIAL_PRICE_SCALED);
  const priceIncreaseScaled = BigInt(PRICE_INCREASE_SCALED);
  // totalSupplyForPricing should already be a BigInt
  return initialPriceScaled + (totalSupplyForPricing * priceIncreaseScaled);
}

function jsCalculatePurchaseAmount(totalSupplyForPricing, mockPaymentAmount) {
  // Convert constant to BigInt
  const precisionForPrice = BigInt(PRECISION_FOR_PRICE);
  // totalSupplyForPricing, mockPaymentAmount should be BigInts
  const price = jsCurrentPriceScaled(totalSupplyForPricing);
  if (price === 0n) { return 0n; } // Avoid division by zero
  return (mockPaymentAmount * precisionForPrice) / price;
}

function jsCalculatePaymentRequired(totalSupplyForPricing, tokenAmount) {
  // Convert constant to BigInt
  const precisionForPrice = BigInt(PRECISION_FOR_PRICE);
  // totalSupplyForPricing, tokenAmount should be BigInts
  const price = jsCurrentPriceScaled(totalSupplyForPricing);
  return (tokenAmount * price) / precisionForPrice;
}

function jsCalculateSaleReturn(totalSupplyForPricing, tokenAmountToSell) {
  // Convert constants to BigInt
  const initialPriceScaled = BigInt(INITIAL_PRICE_SCALED);
  const priceIncreaseScaled = BigInt(PRICE_INCREASE_SCALED);
  const precisionForPrice = BigInt(PRECISION_FOR_PRICE);
  
  // totalSupplyForPricing, tokenAmountToSell should be BigInts
  if (totalSupplyForPricing < tokenAmountToSell) {
    // Mirroring E_INSUFFICIENT_SUPPLY_FOR_SALE from Move
    throw new Error('Insufficient supply for the sale (total_supply_for_pricing < tokenAmountToSell).');
  }
  const supplyAfterSale = totalSupplyForPricing - tokenAmountToSell;
  const priceAtSaleTime = initialPriceScaled + (supplyAfterSale * priceIncreaseScaled);
  return (tokenAmountToSell * priceAtSaleTime) / precisionForPrice;
}