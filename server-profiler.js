import DiscordBasePlugin from './discord-base-plugin.js';
// import TpsLogger from './tps-logger.js';
import { MessageAttachment, WebhookClient } from "discord.js";
import Path from 'path';
import fs from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';

export default class ServerProfiler extends DiscordBasePlugin {
    static get description() {
        return "Server Profiler manager plugin";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            ...DiscordBasePlugin.optionsSpecification,
            channelID: {
                required: true,
                description: 'The ID of the channel to send logs to.',
                default: '',
                example: '667741905228136459'
            },
            enableFileCompression: {
                required: false,
                description: '',
                default: true
            },
            discordWebhook: {
                required: false,
                description: '',
                default: null,
                example: "https://discord.com/api/webhooks/1234567890123456789/tttOOOkkkEEEnnn"
            },
            minimumPlayerCount: {
                required: false,
                description: '',
                default: 5,
            },
            profilingFileDurationMinutes: {
                required: false,
                descritpion: '',
                default: 10
            },
            storeProfilerFilesOnlyIfTpsDropDetected: {
                required: false,
                descritpion: '',
                default: false
            },
            overrideSquadGameDir: {
                required: false,
                descritpion: 'squadserver folder SquadGame/Saved/Profiling',
                default: null
            },
            simulateTpsDrops: {
                required: false,
                description: "",
                default: false
            },
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.matchProfilerLog = this.matchProfilerLog.bind(this);
        this.roundEnded = this.roundEnded.bind(this);
        this.onTpsDrop = this.onTpsDrop.bind(this);
        this.profilerStart = this.profilerStart.bind(this);
        this.profilerStop = this.profilerStop.bind(this);
        this.profilerRestart = this.profilerRestart.bind(this);
        this.sendDiscordCsvReport = this.sendDiscordCsvReport.bind(this);
        this.sendFileBufferToDiscord = this.sendFileBufferToDiscord.bind(this);
        this.deleteProfilerCSV = this.deleteProfilerCSV.bind(this);
        this.profilerStarting = this.profilerStarting.bind(this);
        this.profilerEnded = this.profilerEnded.bind(this);
        this.logLineReceived = this.logLineReceived.bind(this);
        this.tickRateUpdated = this.tickRateUpdated.bind(this);
        this.isTpsDrop = this.isTpsDrop.bind(this);
        this.getLatestTpsRecord = this.getLatestTpsRecord.bind(this);
        this.getAverageTps = this.getAverageTps.bind(this);

        // this.TpsLogger = this.server.plugins.find(p => p instanceof TpsLogger);
        this.backupProfilingFileDurationMinutes = this.options.profilingFileDurationMinutes;

        this.broadcast = this.server.rcon.broadcast;
        this.warn = this.server.rcon.warn;

        this.skipPlayerCheck = false;
        this.deleteProtection = false;
        this.profilerRunning = false;

        this.restartTimeout = null;

        this.tickRates = []
        this.duringTpsDrop = false;

        this.SquadGameDir = this.options?.overrideSquadGameDir?.match(/(.+)(\/SquadGame.*)/)[ 1 ] || this.server.options.logDir.replace(/\\/g, '/').match(/(.+)(\/SquadGame\/.*)/)[ 1 ]
    }

    async profilerStart() {
        const checkPlayerCount = (this.server.players.length < this.options.minimumPlayerCount && !this.skipPlayerCheck);
        this.verbose(1, `Player count: ${this.server.players.length}:${checkPlayerCount} - SkipCheck: ${this.skipPlayerCheck} - Profiler running: ${this.profilerRunning}`)
        if (checkPlayerCount || this.profilerRunning) return;

        await this.server.rcon.execute('AdminProfileServerCSV start');
        this.server.removeListener('CSV_PROFILER_ENDED', this.profilerStart);
        this.server.removeListener('CSV_PROFILER_ALREADY_STOPPED', this.profilerStart);
        this.skipPlayerCheck = false;
    }
    async profilerStop() {
        await this.server.rcon.execute('AdminProfileServerCSV stop');
    }
    async profilerRestart() {
        this.verbose(1, 'Restarting profiler');
        this.server.once('CSV_PROFILER_ENDED', this.profilerStart);
        this.server.once('CSV_PROFILER_ALREADY_STOPPED', this.profilerStart);
        await this.profilerStop();
        // setTimeout(this.profilerStart, 5000)
    }

    async mount() {
        this.verbose(1, 'Mounted.')
        this.verbose(1, 'SquadGame dir: ', this.SquadGameDir)
        // this.bindListeners();
        // console.log(this.server.logParser.processLine)
        this.server.on('ROUND_ENDED', this.roundEnded)
        this.server.on('PROFILER:TPS_DROP_DETECTED', this.onTpsDrop)
        this.server.on('CSV_PROFILER_ENDED', this.profilerEnded)
        this.server.on('CSV_PROFILER_STARTING', this.profilerStarting)
        this.server.on('PLAYER_CONNECTED', this.profilerStart)

        this.server.on('TICK_RATE', this.tickRateUpdated)

        this.server.logParser.logReader.reader.on('line', this.logLineReceived)

        await this.profilerStart();
    }

    async unmount() {
        this.verbose(1, 'TpsLogger unmounted');
    }

    // async checkProfilerRunning(callback){
    //     this.profilerStart()
    //     this.server.once('CSV_PROFILER_ALREADY_RUNNING', (info) => {
    //         if(callback) callback(true);
    //     })
    // }

    async profilerStarting(dt) {
        this.profilerRunning = true;
        clearTimeout(this.restartTimeout);
        this.restartTimeout = setTimeout(this.profilerRestart, this.options.profilingFileDurationMinutes * 60 * 1000);
    }

    async onTpsDrop(dt) {
        this.deleteProtection = true;
        this.verbose(1, 'Detected TPS Drop', dt)
        this.server.once('CSV_PROFILER_ENDED', (info) => {
            this.profilerEnded(info, dt)
        })
        await this.profilerStop();
    }

    async roundEnded(info) {
        this.skipPlayerCheck = true;
        await this.profilerRestart();
    }

    async profilerEnded(info, dt = null) {
        this.profilerRunning = false;
        const csvName = info.groups.csv_file_path.match(/\w+\(\d+_\d+\)\.csv/)[ 0 ];
        const csvPath = info.groups.csv_file_path.match(/SquadGame\/.+\/\w+\(\d+_\d+\)\.csv/)[ 0 ];
        const profilerPath = Path.join(this.SquadGameDir, csvPath)
        // if (dt && this.TpsLogger) this.TpsLogger.tickRates[ dt.id ].profiler_csv_path = csvPath;
        this.verbose(1, 'CSV Profiler ENDED', profilerPath)
        this.profilerStart();

        if (this.options.storeProfilerFilesOnlyIfTpsDropDetected) {
            this.deleteProfilerCSV(info)
        } else {
            this.sendDiscordCsvReport(profilerPath, csvName, () => {
                fs.unlink(profilerPath, () => { });
                this.deleteProtection = false;
                this.deleteProfilerCSV(info)
            });
        }
    }

    deleteProfilerCSV(info) {
        if (this.deleteProtection) return;
        const csvPath = info.groups.csv_file_path.match(/SquadGame\/.+\/\w+\(\d+_\d+\)\.csv/)[ 0 ];
        const profilerPath = Path.join(this.SquadGameDir, csvPath)
        fs.unlink(profilerPath, () => { });
    }

    async sendDiscordCsvReport(csvPath, csvName, callback = () => { }) {
        this.verbose(1, `Processing file ${csvName}`)
        const outputPath = csvPath + '.gz';

        if (this.options.enableFileCompression) {
            const source = fs.createReadStream(csvPath);
            const gzip = createGzip()
            pipeline(source, gzip,
                async (data) => {
                    try {
                        await this.sendFileBufferToDiscord(data, `${(this.server?.currentLayer?.layerid || 'UnknownLayer')}_${csvName}.gz`, this.duringTpsDrop ? '** :bangbang: TPS DROP DETECTED :bangbang: **' : '')
                        this.duringTpsDrop = false;
                    } catch (error) {
                        this.verbose(1, 'Could not send discord message. Error: ', error)
                    }
                    callback();
                },
                async (err) => {
                    if (err) {
                        console.error('An error occurred:', err);
                        process.exitCode = 1;
                    }
                }
            );
        } else {
            await this.sendFileBufferToDiscord(fs.readFileSync(csvPath), csvName)
            callback();
        }
    }

    sendFileBufferToDiscord(buffer, fileName, messageContent = "") {
        let client;
        if (this.options.discordWebhook) {
            this.verbose(1, `Sending ${fileName} to Discord using Webhook: ${this.options.discordWebhook}`)
            // const parsed = this.options.discordWebhook.match(/api\/webhooks\/(?<id>.+)\/(?<token>.+)/)
            // client = new WebhookClient({ id: parsed[ 1 ], token: parsed[ 2 ] });
            client = new WebhookClient({ url: this.options.discordWebhook });
        } else {
            this.verbose(1, `Sending ${fileName} to Discord channel: ${this.options.channelID}`)
            client = this.channel;
        }

        return client.send({
            content: messageContent,
            files: [
                new MessageAttachment(buffer, fileName)
            ]
        })
    }

    async logLineReceived(dt) {
        // this.verbose(1, `Received log line`, dt)
        this.matchProfilerLog(dt);
    }

    matchProfilerLog(line) {
        let regex = /LogCsvProfiler\: Display\: Capture (?<state>\w+)(. CSV ID: (?<csv_id>\w+))?(. Writing CSV to file : (?<csv_file_path>.+))?/
        let match = line.match(regex);
        if (match) {
            const event = `CSV_PROFILER_${match.groups.state.toUpperCase()}`;
            this.server.emit(event, match)
            this.verbose(1, 'Emitting event', event)
        }

        regex = /LogCsvProfiler: Warning: Capture Stop requested, but no capture was running!/
        match = line.match(regex);
        if (match) {
            const event = `CSV_PROFILER_ALREADY_STOPPED`;
            this.server.emit(event, match)
            this.profilerRunning = false;
            this.verbose(1, 'Emitting event', event)
        }

        regex = /LogCsvProfiler: Warning: Capture start requested, but a capture was already running/
        match = line.match(regex);
        if (match) {
            const event = `CSV_PROFILER_ALREADY_RUNNING`;
            this.server.emit(event, match)
            this.profilerRunning = true;
            this.verbose(1, 'Emitting event', event)
        }
    }

    tickRateUpdated(dt) {
        const prevTps = this.tickRates[ this.getLatestTpsRecord() ]?.tickRate || 0
        const tps = this.options.simulateTpsDrops && prevTps > this.getAverageTps(20) * 0.8 && this.tickRates.length > 20 ? this.getAverageTps(20) * 0.8 : dt.tickRate;
        this.tickRates.push({
            tickRate: tps,
            averageTickRate: 0
        })
        this.verbose(1, 'TPS Update', `Handled: ${tps} - Real: ${dt.tickRate} - 20_Average: ${this.getAverageTps(20)} - 3_Average: ${this.getAverageTps(3)} - IsDrop: ${this.isTpsDrop() ? "YES" : "NO"} - History Length: ${this.tickRates.length}`, dt.time)

        if (this.tickRates.length > 100) this.tickRates.shift();

        const latestTpsRecordIndex = this.getLatestTpsRecord();
        this.tickRates[ latestTpsRecordIndex ].averageTickRate = this.getAverageTps();
        this.tickRates[ latestTpsRecordIndex ].id = latestTpsRecordIndex;
        if (this.isTpsDrop()) {
            this.verbose(1, 'Emitting PROFILER:TPS_DROP_DETECTED event')
            this.server.emit('PROFILER:TPS_DROP_DETECTED', this.tickRates[ latestTpsRecordIndex ])
        }

        const amountOfTickratesForAvg = 3;
        if (this.tickRates.slice(-amountOfTickratesForAvg).map(t => t.tickRate).reduce((prev, curr, i) => prev + curr, 0) < this.options.last3TPSThresholdForEndMatch * amountOfTickratesForAvg)
            this.server.rcon.execute(`AdminEndMatch`)
    }

    getLatestTpsRecord() {
        return this.tickRates.length == 0 ? 0 : this.tickRates.length - 1;
    }

    getAverageTps(recentCount = 10) {
        const sliceLength = Math.min(this.tickRates.length, recentCount);
        return this.tickRates.slice(this.tickRates.length - sliceLength).map(t => t.tickRate).reduce((acc, cur) => acc + cur, 0) / sliceLength || 0
    }

    isTpsDrop() {
        this.options.profilingFileDurationMinutes = 5
        this.duringTpsDrop = true;
        setTimeout(() => {
            this.duringTpsDrop = false
        }, 10 * 1000)

        setTimeout(() => {
            this.options.profilingFileDurationMinutes = this.backupProfilingFileDurationMinutes
        }, 15 * 60 * 1000)

        return this.getAverageTps(20) * 0.85 > this.getAverageTps(3);//this.tickRates[ latestTpsRecordIndex ].tickRate
    }
}