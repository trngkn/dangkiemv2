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
async function handleCaptcha(page, retryCount = 0) {
  const MAX_RETRIES = 3;
  const imagePath = 'temp_captcha_image.png';
  
  try {
    // Đảm bảo phần tử captcha tồn tại và hiển thị
    await page.waitForSelector('#captchaImage', { visible: true, timeout: 5000 });
    
    // Chụp màn hình chỉ phần tử captcha
    const captchaElement = await page.$('#captchaImage');
    if (!captchaElement) {
      throw new Error('Không tìm thấy phần tử captcha trên trang.');
    }
    
    // Chụp ảnh phần tử captcha
    await captchaElement.screenshot({ 
      path: imagePath,
      type: 'png',
      omitBackground: true
    });
    
    console.log('Đã chụp ảnh captcha thành công');
    
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

    // Đọc ảnh đã chụp
    const imageBuffer = await fs.readFile(imagePath);
    const imageBase64 = imageBuffer.toString('base64');
    const mimeType = 'image/png'; // Luôn là PNG vì chúng ta chụp màn hình

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
    
  } catch (error) {
    // Xóa file tạm nếu có lỗi
    try {
      await fs.unlink(imagePath).catch(() => {});
    } catch (e) {}
    
    // Nếu có lỗi và chưa vượt quá số lần thử lại
    if (retryCount < MAX_RETRIES) {
      console.log(`Lỗi khi xử lý captcha, thử lại lần ${retryCount + 1}...`);
      
      // Làm mới trang để lấy captcha mới
      await page.reload({ waitUntil: 'networkidle0' });
      
      // Đợi một chút để trang tải xong
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Thử lại với số lần thử tăng lên
      return handleCaptcha(page, retryCount + 1);
    }
    
    // Nếu đã thử đủ số lần mà vẫn lỗi
    throw new Error(`Không thể xử lý captcha sau ${MAX_RETRIES} lần thử: ${error.message}`);
  }
}

// Hàm chính thực hiện tra cứu
async function performVehicleLookup(licensePlate, stickerNumber, retryCount = 0) {
  const MAX_RETRIES = 3; // Tăng số lần thử lại tối đa lên 3
  const RETRY_DELAY = 2000; // Thời gian chờ giữa các lần thử (ms)
  
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
  
  // Bật request interception để tối ưu hiệu suất
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    // Bỏ qua các request không cần thiết như hình ảnh, stylesheet, font
    if (['stylesheet', 'font', 'media'].includes(request.resourceType())) {
      request.abort();
    } else {
      request.continue();
    }
  });

  try {
    console.log(`Đang thực hiện tra cứu lần ${retryCount + 1}...`);
    
    // Truy cập trang web với timeout
    await page.goto('http://app.vr.org.vn/ptpublic/thongtinptpublic.aspx', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Đợi cho đến khi trang tải xong
    //await page.waitForSelector('body', { timeout: 10000 });
    //await new Promise(resolve => setTimeout(resolve, 2000));

    // Xử lý captcha
    try {
      await handleCaptcha(page);
    } catch (captchaError) {
      console.error('Lỗi khi xử lý captcha:', captchaError.message);
      throw new Error(`Lỗi captcha: ${captchaError.message}`);
    }

    // Nhập thông tin biển số
    try {
      await page.waitForSelector('#txtBienDK', { visible: true, timeout: 5000 });
      await page.click('#txtBienDK');
      await page.type('#txtBienDK', licensePlate, { delay: 50 });
      
      await page.waitForSelector('#TxtSoTem', { visible: true, timeout: 5000 });
      await page.click('#TxtSoTem');
      await page.type('#TxtSoTem', stickerNumber, { delay: 50 });
    } catch (inputError) {
      console.error('Lỗi khi nhập thông tin:', inputError.message);
      throw new Error(`Lỗi nhập liệu: ${inputError.message}`);
    }

    // Gửi form
    try {
      await page.waitForSelector('#Form1', { timeout: 5000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }),
        page.evaluate(() => {
          const form = document.getElementById('Form1');
          if (form) form.submit();
        })
      ]);
    } catch (submitError) {
      console.error('Lỗi khi gửi form:', submitError.message);
      // Thử cách khác nếu cách trên thất bại
      await page.click('input[type="submit"]');
      
    }

    // Chờ trang tải xong sau khi submit
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Chụp màn hình kết quả
    try {
      await page.screenshot({ path: 'result.png', fullPage: true });
      console.log('Đã chụp màn hình kết quả thành công');
    } catch (screenshotError) {
      console.error('Lỗi khi chụp màn hình kết quả:', screenshotError.message);
    }

    // Kiểm tra xem có thông báo lỗi không
    const hasError = await page.evaluate(() => {
      const errorElement = document.getElementById('lblErrMsg');
      return errorElement && errorElement.textContent.trim() !== '';
    });

    if (hasError) {
      const errorMessage = await page.evaluate(() => {
        const errorElement = document.getElementById('lblErrMsg');
        return errorElement ? errorElement.textContent.trim() : 'Lỗi không xác định';
      });
      
      // Return immediately if the error is 'vehicle not found'
      if (errorMessage === 'Không tìm thấy thông tin phương tiện này.') {
        throw new Error(errorMessage);
      }
      
      if (retryCount < MAX_RETRIES) {
        console.log(`Phát hiện lỗi "${errorMessage}", thử lại lần ${retryCount + 1}/${MAX_RETRIES}...`);
        await browser.close();
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return performVehicleLookup(licensePlate, stickerNumber, retryCount + 1);
      } else {
        throw new Error(`Đã thử lại ${MAX_RETRIES} lần nhưng vẫn gặp lỗi: ${errorMessage}`);
      }
    }

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

    // Lưu kết quả trước khi xoá cookie
    const finalResult = {
      success: true,
      data: result,
      screenshot: screenshotPath
    };

    // Xoá tất cả cookie sau khi hoàn thành
    try {
      const cookies = await page.cookies();
      if (cookies && cookies.length > 0) {
        await page.deleteCookie(...cookies);
        console.log('Đã xoá tất cả cookie');
      }
    } catch (cookieError) {
      console.warn('Không thể xoá cookie:', cookieError.message);
    }

    return finalResult;

  } catch (error) {
    console.error('Lỗi khi tra cứu:', error);
    throw error;
  } finally {
    // Đảm bảo trình duyệt luôn được đóng
    try {
      await browser.close();
    } catch (e) {
      console.error('Lỗi khi đóng trình duyệt:', e.message);
    }
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
