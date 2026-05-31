const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// Configure Cloudinary with API key + secret (no upload preset)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// Store file in memory so we can stream it to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
}).single('file');

// POST /upload
const uploadFile = (req, res) => {
  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return sendError(res, 400, err.message, ERROR_CODES.VALIDATION_ERROR);
    }
    if (err) {
      return sendError(res, 400, err.message, ERROR_CODES.VALIDATION_ERROR);
    }
    if (!req.file) {
      return sendError(res, 400, 'No file provided', ERROR_CODES.VALIDATION_ERROR);
    }

    const folder = (req.body.folder || 'freshmart_kyc').replace(/[^a-zA-Z0-9_/-]/g, '');

    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder, resource_type: 'image' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          },
        );
        stream.end(req.file.buffer);
      });

      return sendSuccess(res, 200, 'File uploaded', { url: result.secure_url });
    } catch (uploadErr) {
      logger.error('Cloudinary upload error:', uploadErr);
      return sendError(res, 500, 'Failed to upload file', ERROR_CODES.INTERNAL_ERROR);
    }
  });
};

module.exports = { uploadFile };
