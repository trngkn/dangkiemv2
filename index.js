import puppeteer from 'puppeteer';
import express from 'express';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config(); // Tải biến môi trường từ file .env

// Hàm xoá file sau thời gian chờ (tính bằng mili giây)
async function deleteFileAfterDelay(filePath, delayMs = 2 * 60 * 1000) {
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        await fs.unlink(filePath);
        console.log(`Đã xoá file: ${filePath}`);
      } catch (error) {
        console.error(`Lỗi khi xoá file ${filePath}:`, error.message);
      }
      resolve();
    }, delayMs);
  });
}

const app = express();
app.use(express.json());

// Hàm xử lý captcha
async function handleCaptcha(page) {
  const imagePath = 'temp_captcha_image.png';

  let imageUrl = null;
  let retryImage = 0;
  const MAX_IMAGE_RETRY = 3;

  // Thử lại load captcha tối đa 3 lần nếu không tìm thấy ảnh
  while (retryImage < MAX_IMAGE_RETRY) {
    imageUrl = await page.evaluate(() => {
      const img = document.querySelector('#captchaImage');
      return img ? img.src : null;
    });

    if (imageUrl) break;

    retryImage++;
    if (retryImage < MAX_IMAGE_RETRY) {
      // Reload lại trang nếu chưa hết số lần thử
      await page.goto('http://app.vr.org.vn/ptpublic/thongtinptpublic.aspx', { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  if (!imageUrl) {
    throw new Error('Không tìm thấy hình ảnh captcha trên trang sau 3 lần thử.');
  }

  // Tải và xử lý hình ảnh
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Tải hình ảnh thất bại: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(imagePath, Buffer.from(buffer));

  // Khởi tạo Gemini API
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY chưa được thiết lập");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash-latest',
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
    ],
  });

  // Gửi ảnh lên Gemini để nhận diện
  const imageBuffer = await fs.readFile(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const mimeType = response.headers.get('content-type') || 'image/png';

  const result = await model.generateContent([
    "Hãy nhận diện các ký tự trong ảnh captcha này. Chỉ trả về các ký tự đó, không giải thích gì thêm.",
    {
      inlineData: {
        data: imageBase64,
        mimeType: mimeType,
      },
    },
  ]);

  const recognizedText = await result.response.text();
  const captchaText = recognizedText.replace(/[^A-Za-z0-9]/g, '');

  // Nhập captcha
  await page.click('#txtCaptcha');
  await new Promise(resolve => setTimeout(resolve, 1000));
  await page.type('#txtCaptcha', captchaText);

  // Xóa file tạm
  await fs.unlink(imagePath);

  return captchaText;
}

// Hàm chính thực hiện tra cứu
async function performVehicleLookup(licensePlate, stickerNumber) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  });
  const page = await browser.newPage();

  try {
    // Truy cập trang web
    await page.goto('http://app.vr.org.vn/ptpublic/thongtinptpublic.aspx', { waitUntil: 'networkidle2' });

    // Xử lý captcha
    await handleCaptcha(page);

    // Nhập thông tin
    await page.click('#txtBienDK');
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.type('#txtBienDK', licensePlate);

    await page.click('#TxtSoTem');
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.type('#TxtSoTem', stickerNumber);

    // Gửi form
    await new Promise(resolve => setTimeout(resolve, 2000));
    // Sử dụng submit form thay vì click để đảm bảo form được gửi chính xác
    await page.evaluate(() => {
      const form = document.getElementById('Form1');
      form.submit();
    });

    // Chờ một chút để trang tải kết quả
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Chụp ảnh màn hình
    const screenshotPath = `result_${Date.now()}.png`;
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });
    console.log(`Đã lưu ảnh màn hình tại: ${screenshotPath}`);
    
    // Lên lịch xoá ảnh sau 5 phút
    deleteFileAfterDelay(screenshotPath);

    // Lấy kết quả từ trang
    const result = await page.evaluate(() => {
      const resultElement = document.querySelector('.result');
      return resultElement ? resultElement.innerHTML : 'Không tìm thấy kết quả';
    });

    return {
      success: true,
      data: result,
      screenshot: screenshotPath
    };

  } catch (error) {
    console.error('Lỗi khi tra cứu:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// API endpoint
app.post('/api/vehicle-lookup', async (req, res) => {
  const { licensePlate, stickerNumber, returnBase64 = true } = req.body;

  if (!licensePlate || !stickerNumber) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ biển số và số tem' });
  }

  try {
    const result = await performVehicleLookup(licensePlate, stickerNumber);
    
    // Nếu yêu cầu trả về base64 (mặc định cho n8n)
    if (returnBase64) {
      try {
        // Đọc file ảnh và chuyển sang base64
        const imageBuffer = await fs.readFile(result.screenshot);
        const base64Image = imageBuffer.toString('base64');
        
        // Trả về dữ liệu dạng base64 để n8n có thể xử lý
        res.json({
          success: result.success,
          data: result.data,
          screenshot: {
            filename: path.basename(result.screenshot),
            mimeType: 'image/png',
            data: base64Image
          },
          // Thêm URL tạm thời nếu cần
          screenshotUrl: `/screenshots/${path.basename(result.screenshot)}`
        });
      } catch (error) {
        console.error('Lỗi khi đọc file ảnh:', error);
        res.status(500).json({ 
          error: 'Lỗi khi xử lý ảnh', 
          details: error.message 
        });
      }
    } else {
      // Nếu không yêu cầu base64, trả về như cũ
      res.json(result);
    }
  } catch (error) {
    console.error('Lỗi khi xử lý yêu cầu:', error);
    res.status(500).json({ 
      error: 'Có lỗi xảy ra khi xử lý yêu cầu', 
      details: error.message 
    });
  }
});

// Thêm route để phục vụ file ảnh tĩnh
app.use('/screenshots', express.static(__dirname));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});

// Khởi động server
(async () => {
  try {
    console.log('Server đã khởi động. Đợi request từ client...');
  } catch (error) {
    console.error('Lỗi khi khởi động server:', error);
    process.exit(1);
  }
})();
