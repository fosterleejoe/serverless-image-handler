// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const sharp = require('sharp');

class ImageHandler {
    constructor(s3, rekognition) {
        this.s3 = s3;
        this.rekognition = rekognition;
    }

    /**
     * Main method for processing image requests and outputting modified images.
     * @param {ImageRequest} request - An ImageRequest object.
     */
    async process(request) {
        let returnImage = '';
        const originalImage = request.originalImage;
        const edits = request.edits;

        if (edits !== undefined && Object.keys(edits).length > 0) {
            let image = null;
            const keys = Object.keys(edits);

            if (keys.includes('rotate') && edits.rotate === null) {
                image = sharp(originalImage, { failOnError: false });
            } else {
                const metadata = await sharp(originalImage, { failOnError: false }).metadata();
                if (metadata.orientation) {
                    image = sharp(originalImage, { failOnError: false }).withMetadata({ orientation: metadata.orientation });
                } else {
                    image = sharp(originalImage, { failOnError: false }).withMetadata();
                }
            }

            const modifiedImage = await this.applyEdits(image, edits);
            if (request.outputFormat !== undefined) {
                modifiedImage.toFormat(request.outputFormat);
            }
            const bufferImage = await modifiedImage.toBuffer();
            returnImage = bufferImage.toString('base64');
        } else {
            returnImage = originalImage.toString('base64');
        }

        // If the converted image is larger than Lambda's payload hard limit, throw an error.
        const lambdaPayloadLimit = 6 * 1024 * 1024;
        if (returnImage.length > lambdaPayloadLimit) {
            throw {
                status: '413',
                code: 'TooLargeImageException',
                message: 'The converted image is too large to return.'
            };
        }

        return returnImage;
    }

    /**
     * Applies image modifications to the original image based on edits
     * specified in the ImageRequest.
     * @param {Sharp} image - The original sharp image.
     * @param {object} edits - The edits to be made to the original image.
     */
    async applyEdits(image, edits) {
        if (edits.resize === undefined) {
            edits.resize = {};
            edits.resize.fit = 'inside';
        } else {
            if (edits.resize.width) edits.resize.width = Number(edits.resize.width);
            if (edits.resize.height) edits.resize.height = Number(edits.resize.height);
        }

        // Apply the image edits
        for (const editKey in edits) {
            const value = edits[editKey];
            if (editKey === 'overlayWith') {
                const metadata = await image.metadata();
                let imageMetadata = metadata;
                if (edits.resize) {
                    let imageBuffer = await image.toBuffer();
                    imageMetadata = await sharp(imageBuffer).resize({ edits: { resize: edits.resize }}).metadata();
                }

                const { bucket, key, wRatio, hRatio, alpha } = value;
                const overlay = await this.getOverlayImage(bucket, key, wRatio, hRatio, alpha, imageMetadata);
                const overlayMetadata = await sharp(overlay).metadata();

                let { options } = value;
                if (options) {
                    if (options.left !== undefined) {
                        let left = options.left;
                        if (isNaN(left) && left.endsWith('p')) {
                            left = parseInt(left.replace('p', ''));
                            if (left < 0) {
                                left = imageMetadata.width + (imageMetadata.width * left / 100) - overlayMetadata.width;
                            } else {
                                left = imageMetadata.width * left / 100;
                            }
                        } else {
                            left = parseInt(left);
                            if (left < 0) {
                                left = imageMetadata.width + left - overlayMetadata.width;
                            }
                        }
                        isNaN(left) ? delete options.left : options.left = left;
                    }
                    if (options.top !== undefined) {
                        let top = options.top;
                        if (isNaN(top) && top.endsWith('p')) {
                            top = parseInt(top.replace('p', ''));
                            if (top < 0) {
                                top = imageMetadata.height + (imageMetadata.height * top / 100) - overlayMetadata.height;
                            } else {
                                top = imageMetadata.height * top / 100;
                            }
                        } else {
                            top = parseInt(top);
                            if (top < 0) {
                                top = imageMetadata.height + top - overlayMetadata.height;
                            }
                        }
                        isNaN(top) ? delete options.top : options.top = top;
                    }
                }

                const params = [{ ...options, input: overlay }];
                image.composite(params);
            } else if (editKey === 'smartCrop') {
                const options = value;
                const metadata = await image.metadata();
                const imageBuffer = await image.toBuffer();
                const boundingBox = await this.getBoundingBox(imageBuffer, options.faceIndex);
                const cropArea = this.getCropArea(boundingBox, options, metadata);
                try {
                    image.extract(cropArea);
                } catch (err) {
                    throw {
                        status: 400,
                        code: 'SmartCrop::PaddingOutOfBounds',
                        message: 'The padding value you provided exceeds the boundaries of the original image. Please try choosing a smaller value or applying padding via Sharp for greater specificity.'
                    };
                }
            } else if (editKey === 'smartCrop2') {
                const options = value;
                const metadata = await image.metadata();
                const imageBuffer = await image.toBuffer();
                const boundingBox = await this.getBoundingBox2(imageBuffer, options.minConfidence);
                const cropArea = this.getCropArea(boundingBox, options, metadata);
                try {
                    image.extract(cropArea);
                } catch (err) {
                    throw {
                        status: 400,
                        code: 'SmartCrop::PaddingOutOfBounds',
                        message: 'The padding value you provided exceeds the boundaries of the original image. Please try choosing a smaller value or applying padding via Sharp for greater specificity.'
                    };
                }
            } else {
                image[editKey](value);
            }
        }
        // Return the modified image
        return image;
    }

    /**
     * Gets an image to be used as an overlay to the primary image from an
     * Amazon S3 bucket.
     * @param {string} bucket - The name of the bucket containing the overlay.
     * @param {string} key - The object keyname corresponding to the overlay.
     * @param {number} wRatio - The width rate of the overlay image.
     * @param {number} hRatio - The height rate of the overlay image.
     * @param {number} alpha - The transparency alpha to the overlay.
     * @param {object} sourceImageMetadata - The metadata of the source image.
     */
    async getOverlayImage(bucket, key, wRatio, hRatio, alpha, sourceImageMetadata) {
        const params = { Bucket: bucket, Key: key };
        try {
            const { width, height } = sourceImageMetadata;
            const overlayImage = await this.s3.getObject(params).promise();
            let resize = {
                fit: 'inside'
            }

            // Set width and height of the watermark image based on the ratio
            const zeroToHundred = /^(100|[1-9]?[0-9])$/;
            if (zeroToHundred.test(wRatio)) {
                resize['width'] = parseInt(width * wRatio / 100);
            }
            if (zeroToHundred.test(hRatio)) {
                resize['height'] = parseInt(height * hRatio / 100);
            }

            // If alpha is not within 0-100, the default alpha is 0 (fully opaque).
            if (zeroToHundred.test(alpha)) {
                alpha = parseInt(alpha);
            } else {
                alpha = 0;
            }

            const convertedImage = await sharp(overlayImage.Body)
                .resize(resize)
                .composite([{
                    input: Buffer.from([255, 255, 255, 255 * (1 - alpha / 100)]),
                    raw: {
                        width: 1,
                        height: 1,
                        channels: 4
                    },
                    tile: true,
                    blend: 'dest-in'
                }]).toBuffer();
            return convertedImage;
        } catch (err) {
            throw {
                status: err.statusCode ? err.statusCode : 500,
                code: err.code,
                message: err.message
            };
        }
    }

    /**
     * Calculates the crop area for a smart-cropped image based on the bounding
     * box data returned by Amazon Rekognition, as well as padding options and
     * the image metadata.
     * @param {Object} boundingBox - The boudning box of the detected face.
     * @param {Object} options - Set of options for smart cropping.
     * @param {Object} metadata - Sharp image metadata.
     */
    getCropArea(boundingBox, options, metadata) {
        const padding = (options.padding !== undefined) ? parseFloat(options.padding) : 0;
        // Calculate the smart crop area
        const left = (parseInt((boundingBox.Left * metadata.width) - padding) > 0 ? parseInt((boundingBox.Left * metadata.width) - padding) : 0);
        const top = (parseInt((boundingBox.Top * metadata.height) - padding) > 0 ? parseInt((boundingBox.Top * metadata.height) - padding) : 0);
        const width = ((left + parseInt((boundingBox.Width * metadata.width) + (padding * 2))) < metadata.width ? parseInt((boundingBox.Width * metadata.width) + (padding * 2)) : metadata.width - left);
        const height = ((top + parseInt((boundingBox.Height * metadata.height) + (padding * 2))) < metadata.height ? parseInt((boundingBox.Height * metadata.height) + (padding * 2)) : metadata.height - top);
        const cropArea = {
            left : left,
            top : top,
            width : width,
            height : height,
        }
        console.log(metadata, cropArea);
        // Return the crop area
        return cropArea;
    }

    /**
     * Gets the bounding box of the specified face index within an image, if specified.
     * @param {Sharp} imageBuffer - The original image.
     * @param {Integer} faceIndex - The zero-based face index value, moving from 0 and up as
     * confidence decreases for detected faces within the image.
     */
    async getBoundingBox(imageBuffer, faceIndex) {
        const params = { Image: { Bytes: imageBuffer }};
        const faceIdx = (faceIndex !== undefined) ? faceIndex : 0;
        try {
            const response = await this.rekognition.detectFaces(params).promise();
            return response.FaceDetails[faceIdx].BoundingBox;
        } catch (err) {
            console.error(err);
            if (err.message === "Cannot read property 'BoundingBox' of undefined") {
                throw {
                    status: 400,
                    code: 'SmartCrop::FaceIndexOutOfRange',
                    message: 'You have provided a FaceIndex value that exceeds the length of the zero-based detectedFaces array. Please specify a value that is in-range.'
                };
            } else {
                throw {
                    status: 500,
                    code: err.code,
                    message: err.message
                };
            }
        }
    }

    /**
     * Gets the bounding box containing all features within an image.
     * @param {Sharp} imageBuffer - The original image.
     * @param {Integer} minConfidence - The minimum confidence for detected labels.
     */
    async getBoundingBox2(imageBuffer, minConfidence) {
        const minConfidenceParam = (minConfidence !== undefined) ? minConfidence : 0;
        const params = { Image: { Bytes: imageBuffer }, MinConfidence: minConfidenceParam };
        try {
            let boundingBox = {
              "Height": 0,
              "Left": 0.5,
              "Top": 0.5,
              "Width": 0
            }
            const response = await this.rekognition.detectLabels(params).promise();
            console.log(response);
            let labelInstancesdetected = 0;
            for (const label of response.Labels) {
              //console.log("Label detected: ", label.Name, "Confidence: ", label.Confidence);
              for (const instance of label.Instances){
                console.log("Label Instance detected: ", label.Name, "Label Confidence: ", label.Confidence, "Instance Confidence: ", instance.Confidence);
                labelInstancesdetected += 1;
                // Top coordinate as % of image
                boundingBox.Top = (instance.BoundingBox.Top < boundingBox.Top ? instance.BoundingBox.Top : boundingBox.Top);
                // Left coordinate as % of image
                boundingBox.Left = (instance.BoundingBox.Left < boundingBox.Left ? instance.BoundingBox.Left : boundingBox.Left);
                // Height as % of image
                const lowerCoord = instance.BoundingBox.Top + instance.BoundingBox.Height;
                boundingBox.Height = ((instance.BoundingBox.Top + instance.BoundingBox.Height) > (boundingBox.Top + boundingBox.Height) ? (instance.BoundingBox.Top + instance.BoundingBox.Height) - boundingBox.Top : boundingBox.Height);
                // Width as % of image
                boundingBox.Width = ((instance.BoundingBox.Left + instance.BoundingBox.Width) > (boundingBox.Left + boundingBox.Width) ? (instance.BoundingBox.Left + instance.BoundingBox.Width) - boundingBox.Left : boundingBox.Width);;
                console.log("Bounding Box :", boundingBox);
              }
            }
            if  ( labelInstancesdetected == 0) {
              // No label instances detected, return full image
              boundingBox = {
                "Height": 1,
                "Left": 0,
                "Top": 0,
                "Width": 1
              }
            }
            return boundingBox;
        } catch (err) {
            console.error(err);
            if (err.message === "Cannot read property 'BoundingBox' of undefined") {
                throw {
                    status: 400,
                    code: 'SmartCrop::FaceIndexOutOfRange',
                    message: 'You have provided a FaceIndex value that exceeds the length of the zero-based detectedFaces array. Please specify a value that is in-range.'
                };
            } else {
                throw {
                    status: 500,
                    code: err.code,
                    message: err.message
                };
            }
        }
    }
}

// Exports
module.exports = ImageHandler;
