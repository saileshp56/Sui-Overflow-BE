const fs = require('fs');
const path = require('path');
const { DecisionTreeClassifier } = require('ml-cart'); // Using ml-cart now
const csvParser = require('csv-parser');

// Store trained models in memory
const trainedModels = {};

/**
 * Train a decision tree model using the specified CSV file and hyperparameters
 * @param {string} fileId - The ID of the file to use for training (without .csv extension)
 * @param {number} maxDepth - Maximum depth of the decision tree
 * @param {number} minSamplesLeaf - Minimum samples required at a leaf node
 * @param {number} minSamplesSplit - Minimum samples required to split an internal node
 * @param {string} criterion - The function to measure the quality of a split ('gini' or 'entropy')
 * @returns {Object} - Information about the trained model
 */
async function trainModel(fileId, maxDepth = 5, minSamplesLeaf = 1, minSamplesSplit = 2, criterion = 'gini') {
  try {
    console.log(`Training model with file ID: ${fileId}`);
    console.log(`Hyperparameters: maxDepth=${maxDepth}, minSamplesLeaf=${minSamplesLeaf}, minSamplesSplit=${minSamplesSplit}, criterion=${criterion}`);

    maxDepth = maxDepth ? parseInt(maxDepth) : 5;
    minSamplesLeaf = minSamplesLeaf ? parseInt(minSamplesLeaf) : 1;
    minSamplesSplit = minSamplesSplit ? parseInt(minSamplesSplit) : 2;

    const csvFilePath = path.join(__dirname, 'data', 'trainingsets', `${fileId}.csv`);

    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`Training data file not found: ${csvFilePath}`);
    }

    const data = await readCsvFile(csvFilePath); // This `data` will be array of objects

    if (data.length === 0) {
      throw new Error('No valid data rows found in the CSV file after parsing.');
    }

    console.log(`Loaded ${data.length} training examples from CSV.`);

    const columns = Object.keys(data[0]);
    const targetAttribute = columns[columns.length - 1]; // Assume last column is target
    const featureNames = columns.filter(col => col !== targetAttribute); // All other columns are features

    console.log(`All Columns from CSV: ${columns.join(', ')}`);
    console.log(`Inferred Features: ${featureNames.join(', ')}`);
    console.log(`Inferred Target Attribute: ${targetAttribute}`);

    // --- Critical Validation Checks (Keep these for robustness) ---
    if (!columns.includes(targetAttribute)) {
      throw new Error(`Target attribute "${targetAttribute}" not found in CSV columns. Please check your CSV format.`);
    }
    if (featureNames.length === 0) {
      throw new Error('No features found for training. Check CSV format and target attribute.');
    }
    for (const feature of featureNames) {
      if (!columns.includes(feature)) {
        throw new Error(`Feature "${feature}" not found in CSV columns. This indicates a parsing or data issue.`);
      }
    }
    // Check if target attribute has valid values (not all undefined/null/empty)
    const hasValidTargetValues = data.some(row => row[targetAttribute] !== undefined && row[targetAttribute] !== null && String(row[targetAttribute]).trim() !== '');
    if (!hasValidTargetValues) {
      throw new Error(`Target attribute "${targetAttribute}" has no valid values in the training data.`);
    }
    // --- End Critical Validation Checks ---

    // ml-cart expects features as a 2D array (X) and target as a 1D array (y)
    const X = data.map(row => featureNames.map(feature => row[feature]));
    // Target is now used as is (number or string) from the parsed data
    const y = data.map(row => row[targetAttribute]);

    console.log(`Transformed X (features) shape: ${X.length}x${X[0].length}`);
    console.log(`Transformed y (target) shape: ${y.length}`);

    // Configure ml-cart classifier with hyperparameters
    const options = {
      seed: 3, // For reproducibility, optional
      maxDepth: maxDepth,
      minSamplesLeaf: minSamplesLeaf,
      minSamplesSplit: minSamplesSplit,
      gainFunction: criterion === 'entropy' ? 'entropy' : 'gini', // ml-cart uses gainFunction
    };

    console.log('Training ml-cart DecisionTreeClassifier with options:', JSON.stringify(options, null, 2));

    const classifier = new DecisionTreeClassifier(options);

    // Train the model
    classifier.train(X, y);

    // Store the trained model
    trainedModels[fileId] = {
      model: classifier, // Store the ml-cart classifier instance
      features: featureNames, // Store feature names for prediction
      target: targetAttribute,
      hyperparameters: {
        maxDepth,
        minSamplesLeaf,
        minSamplesSplit,
        criterion
      },
      trainedAt: new Date().toISOString()
    };

    console.log('Model trained successfully using ml-cart.');

    const modelInfo = {
      fileId,
      features: featureNames,
      target: targetAttribute,
      hyperparameters: {
        maxDepth,
        minSamplesLeaf,
        minSamplesSplit,
        criterion
      },
      trainedAt: trainedModels[fileId].trainedAt,
      numExamples: data.length
    };

    const modelInfoPath = path.join(__dirname, 'data', 'models', `${fileId}_info.json`);
    const modelsDir = path.join(__dirname, 'data', 'models');
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    fs.writeFileSync(modelInfoPath, JSON.stringify(modelInfo, null, 2));
    console.log(`Model info saved to: ${modelInfoPath}`);

    return modelInfo;
  } catch (error) {
    console.error('Error training model:', error);
    throw error;
  }
}

/**
 * Make predictions using a trained decision tree model
 * @param {string} fileId - The ID of the file used to train the model
 * @param {Object|Array} input - Input features for prediction (single object or array of objects)
 * @returns {Object} - Predictions and accuracy if labels are provided
 */
function predictWithModel(fileId, input) {
  try {
    if (!trainedModels[fileId] || !trainedModels[fileId].model) {
      throw new Error(`No trained model found for file ID: ${fileId}. Model might not have been trained or failed to load.`);
    }

    const { model, features, target } = trainedModels[fileId];

    let inputForPrediction;
    let isSingleInput = false;

    if (Array.isArray(input)) {
      // Map array of objects to 2D array of feature values
      inputForPrediction = input.map(item =>
        features.map(feature => {
          if (item[feature] === undefined) {
            console.error(`Missing feature '${feature}' in input item for prediction:`, item);
            throw new Error(`Missing required feature: ${feature} in input item`);
          }
          return item[feature];
        })
      );
    } else {
      // Map single object to 1D array of feature values
      isSingleInput = true;
      inputForPrediction = features.map(feature => {
        if (input[feature] === undefined) {
          console.error(`Missing feature '${feature}' in single input for prediction:`, input);
          throw new Error(`Missing required feature: ${feature}`);
        }
        return input[feature];
      });
    }

    console.log("Input for prediction (ml-cart format):", inputForPrediction);
    // Perform prediction
    const predictions = model.predict(inputForPrediction); // ml-cart predict returns an array of predictions

    const result = {};

    if (isSingleInput) {
      result.predictions = [predictions]; // predictions will be a single value
      result.input = input;
      result.prediction = predictions; // Store direct prediction value

      // If the input has the target attribute, check if prediction is correct
      if (input[target] !== undefined) {
        result.actual = input[target]; // Removed String() conversion
        result.correct = predictions === result.actual;
        result.accuracy = result.correct ? 1 : 0;
      }
    } else {
      const processedPredictions = [];
      let correctPredictions = 0;
      let totalWithLabels = 0;

      for (let i = 0; i < input.length; i++) {
        const item = input[i];
        const prediction = predictions[i]; // Get the corresponding prediction

        const itemResult = {
          input: item,
          prediction: prediction
        };

        if (item[target] !== undefined) {
          itemResult.actual = item[target]; // Removed String() conversion
          itemResult.correct = prediction === itemResult.actual;

          totalWithLabels++;
          if (itemResult.correct) {
            correctPredictions++;
          }
        }
        processedPredictions.push(itemResult);
      }

      result.predictions = processedPredictions;

      if (totalWithLabels > 0) {
        result.accuracy = correctPredictions / totalWithLabels;
        result.correctPredictions = correctPredictions;
        result.totalWithLabels = totalWithLabels;
        result.accuracyPercentage = Math.round((correctPredictions / totalWithLabels) * 100) + '%';
      }
    }

    return result;

  } catch (error) {
    console.error('Error making prediction:', error);
    throw error;
  }
}

/**
 * Helper function to read and parse a CSV file
 * @param {string} filePath - Path to the CSV file
 * @returns {Promise<Array>} - Promise resolving to an array of objects
 */
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    let processedRowsCount = 0;

    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => {
        const processedRow = {};
        let isEmptyRow = true;

        for (const key in row) {
            let value = row[key];
            if (typeof value === 'string') {
                value = value.trim();
            }

            if (value !== '' && !isNaN(parseFloat(value)) && isFinite(value)) {
                processedRow[key] = parseFloat(value);
                isEmptyRow = false;
            } else if (value !== '') {
                processedRow[key] = value;
                isEmptyRow = false;
            }
        }

        // --- REMOVED: Explicit conversion of 'variety' to string ---
        // if (processedRow['variety'] !== undefined && processedRow['variety'] !== null) {
        //     processedRow['variety'] = String(processedRow['variety']);
        // }
        // --- END REMOVED ---

        if (!isEmptyRow && Object.keys(processedRow).length > 0) {
            results.push(processedRow);
            processedRowsCount++;
        }
      })
      .on('end', () => {
        if (results.length === 0) {
            if (processedRowsCount === 0) {
                console.error("CSV file is empty or contains only headers, no data rows found.");
                reject(new Error("CSV file is empty or contains no data rows."));
            } else {
                console.error("CSV parsing completed, but the results array is unexpectedly empty.");
                reject(new Error("CSV parsing completed, but no valid data could be extracted."));
            }
        } else {
          console.log(`Successfully parsed ${results.length} valid data rows from CSV.`);
          resolve(results);
        }
      })
      .on('error', (error) => {
        console.error('Error reading CSV file during stream processing:', error);
        reject(error);
      });
  });
}

module.exports = {
  trainModel,
  predictWithModel
};