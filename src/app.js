import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { db } from './db.js';
import cron from 'node-cron';
import axios from 'axios';
import { DateTime } from 'luxon';
import {alertsUrl, locationId, isAlertSymbols} from "./constants.js";

const tgToken = process.env.TG_TOKEN;
const alertsToken = process.env.ALERTS_TOKEN;
if (!tgToken) throw new Error('TG_TOKEN is missing');
if (!alertsToken) throw new Error('ALERTS_TOKEN is missing');
const bot = new TelegramBot(tgToken, { polling: true });

console.log('Bot is running!');

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (tg_user_id, tg_chat_id)
  VALUES (@tg_user_id, @tg_chat_id)
`);
const updateChat = db.prepare(`
  UPDATE users SET tg_chat_id = @tg_chat_id WHERE tg_user_id = @tg_user_id
`);
const selectUserByTg = db.prepare(`
  SELECT * FROM users WHERE tg_user_id = ?
`);

const insertAlarm = db.prepare(`
  INSERT INTO alarms (user_id, label, hour, minute, days_mask, repeats, interval)
  VALUES (@user_id, @label, @hour, @minute, @days_mask, @repeats, @interval)
  RETURNING *;
`);
const selectAlarmsByUser = db.prepare(`
  SELECT * FROM alarms WHERE user_id = ? ORDER BY hour, minute
`);
const deleteAlarm = db.prepare(`
  DELETE FROM alarms WHERE id = ? AND user_id = ?
`);
const selectDueAlarms = db.prepare(`
    SELECT a.*, u.tg_chat_id
    FROM alarms a
    JOIN users u ON u.id = a.user_id
    WHERE a.enabled = 1
      AND a.hour = ?
      AND a.minute = ?
      AND (a.days_mask & ?) != 0
`);


function daysToMask(days) {
    return days.reduce((mask, d) => mask | (1 << (d-1)), 0);
}
function maskToDays(mask) {
    const dayNames = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    return dayNames.filter((_, i) => mask & (1 << i));
}

async function checkAlert() {
    const response = await axios({
        method: 'GET',
        url: `${alertsUrl}/iot/active_air_raid_alerts/${locationId}.json`,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${alertsToken}`
        },
    })
    const data = response.data;

    const isAlert = isAlertSymbols.includes(data)

    return isAlert
}


const alarmDrafts = new Map();

bot.onText(/^\/health$/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Бот работает');
});

bot.onText(/^\/start$/, (msg) => {
    const params = { tg_user_id: msg.from.id, tg_chat_id: msg.chat.id };
    insertUser.run(params);
    updateChat.run(params);
    bot.sendMessage(msg.chat.id, 'Привет! Установи будильник: /alarm');
});

bot.onText(/^\/alarm$/, (msg) => {
    const user = selectUserByTg.get(msg.from.id);
    if (!user) return bot.sendMessage(msg.chat.id, 'Сначала /start');

    const chatId = msg.chat.id;

    const hoursKeyboard = [];
    for (let row = 0; row < 4; row++) {
        const rowButtons = [];
        for (let col = 0; col < 6; col++) {
            const h = row * 6 + col;
            if (h < 24) rowButtons.push({ text: h.toString().padStart(2,'0'), callback_data: `hour_${h}` });
        }
        hoursKeyboard.push(rowButtons);
    }

    bot.sendMessage(chatId, 'Выбери час:', {
        reply_markup: { inline_keyboard: hoursKeyboard }
    });
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;

    if (query.data.startsWith('hour_')) {
        const hour = parseInt(query.data.split('_')[1]);
        alarmDrafts.set(query.from.id, { hour, minute: null, days: [], repeats: 3, interval: 2000 });

        const minutesKeyboard = [];
        for (let row = 0; row < 3; row++) {
            const rowButtons = [];
            for (let col = 0; col < 4; col++) {
                const m = (row * 4 + col) * 5;
                if (m < 60) rowButtons.push({ text: m.toString().padStart(2,'0'), callback_data: `minute_${hour}_${m}` });
            }
            minutesKeyboard.push(rowButtons);
        }

        bot.editMessageText(`Выбран час: ${hour.toString().padStart(2,'0')}\nТеперь выбери минуты:`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: minutesKeyboard }
        });
    }

    if (query.data.startsWith('minute_')) {
        const [_, hour, minute] = query.data.split('_');
        alarmDrafts.set(query.from.id, { hour: Number(hour), minute: Number(minute), days: [], repeats: 3, interval: 2000 });

        const daysRow = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => ({ text: d, callback_data: `day_${d}` }));
        bot.editMessageText(
            `Выбрано время: ${hour.padStart(2,'0')}:${minute.padStart(2,'0')}\nТеперь выбери дни недели:`,
            {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: [daysRow] }
            }
        );
    }

    if (query.data.startsWith('day_')) {
        const dayNames = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
        const day = query.data.split('_')[1];
        const draft = alarmDrafts.get(query.from.id);

        if (!draft) return bot.answerCallbackQuery(query.id);

        if (draft.days.includes(day)) {
            draft.days = draft.days.filter(d => d !== day);
        } else {
            draft.days.push(day);
        }

        draft.days.sort((a, b) => dayNames.indexOf(a) - dayNames.indexOf(b));

        alarmDrafts.set(query.from.id, draft);


        const daysRow = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => {
            const mark = draft.days.includes(d) ? `✅ ${d}` : d;
            return { text: mark, callback_data: `day_${d}` };
        });
        const nextStep = [{ text: '➡️ Далее', callback_data: 'ask_repeats' }];

        bot.editMessageText(
            `Время: ${draft.hour.toString().padStart(2,'0')}:${draft.minute.toString().padStart(2,'0')}\nДни: ${draft.days.join(', ')}\nВыбери дни или перейди дальше:`,
            {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: [daysRow, nextStep] }
            }
        );
    }

    if (query.data === 'ask_repeats') {
        const keyboard = [
            [
                { text: '1', callback_data: 'repeats_1' },
                { text: '2', callback_data: 'repeats_2' },
                { text: '3', callback_data: 'repeats_3' },
                { text: '5', callback_data: 'repeats_5' },
                { text: '10', callback_data: 'repeats_10' },
                { text: '20', callback_data: 'repeats_20' },
            ]
        ];
        bot.editMessageText('Сколько раз повторять сигнал?', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    if (query.data.startsWith('repeats_')) {
        const repeats = parseInt(query.data.split('_')[1]);
        const draft = alarmDrafts.get(query.from.id);
        draft.repeats = repeats;
        alarmDrafts.set(query.from.id, draft);

        const keyboard = [
            [
                { text: '3с', callback_data: 'interval_3' },
                { text: '5с', callback_data: 'interval_5' },
                { text: '7с', callback_data: 'interval_7' },
                { text: '10с', callback_data: 'interval_10' },
                { text: '15с', callback_data: 'interval_15' },
                { text: '20с', callback_data: 'interval_20' },
            ]
        ];
        bot.editMessageText('Интервал между повторами?', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    if (query.data.startsWith('interval_')) {
        const interval = parseInt(query.data.split('_')[1]);
        const draft = alarmDrafts.get(query.from.id);
        const user = selectUserByTg.get(query.from.id);
        if (!draft || !user) return bot.answerCallbackQuery(query.id);

        draft.interval = interval;

        const dayNames = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
        const dayNums = draft.days.map(d => dayNames.indexOf(d)+1);
        const mask = daysToMask(dayNums);

        const alarm = insertAlarm.get({
            user_id: user.id,
            label: `Будильник ${draft.hour.toString().padStart(2,'0')}:${draft.minute.toString().padStart(2,'0')}`,
            hour: draft.hour,
            minute: draft.minute,
            days_mask: mask,
            repeats: draft.repeats,
            interval: draft.interval
        });

        bot.editMessageText(
            `✅ Будильник сохранён на ${draft.hour.toString().padStart(2,'0')}:${draft.minute.toString().padStart(2,'0')} (${draft.days.join(', ')}), повторов: ${draft.repeats}, интервал: ${draft.interval}с`,
            {
                chat_id: chatId,
                message_id: query.message.message_id
            }
        );

        alarmDrafts.delete(query.from.id);
    }

    if (query.data.startsWith('del_')) {
        const alarmId = parseInt(query.data.split('_')[1]);
        const user = selectUserByTg.get(query.from.id);
        if (!user) return bot.answerCallbackQuery(query.id);

        deleteAlarm.run(alarmId, user.id);

        bot.editMessageText('❌ Будильник удалён', {
            chat_id: chatId,
            message_id: query.message.message_id
        });

        return bot.answerCallbackQuery(query.id, { text: 'Удалено' });
    }

    bot.answerCallbackQuery(query.id);
});

bot.onText(/^\/alarms$/, (msg) => {
    const user = selectUserByTg.get(msg.from.id);
    if (!user) return bot.sendMessage(msg.chat.id, 'Сначала /start');

    const rows = selectAlarmsByUser.all(user.id);
    if (!rows.length) return bot.sendMessage(msg.chat.id, 'Будильников нет');

    rows.forEach(alarm => {
        const days = maskToDays(alarm.days_mask).join(', ');
        const text = `${alarm.hour.toString().padStart(2,'0')}:${alarm.minute.toString().padStart(2,'0')} → ${days}, повторов: ${alarm.repeats}, интервал: ${alarm.interval}с`;

        bot.sendMessage(msg.chat.id, text, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '❌ Удалить', callback_data: `del_${alarm.id}` }
                ]]
            }
        });
    });
});

bot.onText(/^\/check$/, async (msg) => {
    const isAlertActive = await checkAlert();

    const text = isAlertActive ? '🔴 Тревога активна' : '🟢 Тревога не активна';

    await bot.sendMessage(msg.chat.id, text)
})


const pendingAlarms = new Map();
cron.schedule('*/1 * * * *', async () => {
    const now = DateTime.now().setZone('Europe/Kyiv');
    const h = now.hour;
    const m = now.minute;
    const dowBit = 1 << (now.weekday - 1);

    const dueAlarms = selectDueAlarms.all(h, m, dowBit);
    for (const alarm of dueAlarms) {
        const key = `${alarm.id}_${alarm.tg_chat_id}`;
        if (pendingAlarms.has(key)) continue;

        const waitAndFire = async () => {
            let isAlertActive = await checkAlert();

            while (isAlertActive) {
                await new Promise(res => setTimeout(res, 60 * 1000));
                isAlertActive = await checkAlert();
            }

            for (let i = 0; i < alarm.repeats; i++) {
                setTimeout(() => {
                    bot.sendMessage(alarm.tg_chat_id, `⏰ #${i + 1} ${alarm.label}`);
                }, i * alarm.interval * 1000);
            }

            pendingAlarms.delete(key);
        };

        pendingAlarms.set(key, waitAndFire());
    }
});
