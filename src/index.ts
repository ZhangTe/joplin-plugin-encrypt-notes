import joplin from 'api';
import { SettingItemType , ToolbarButtonLocation, MenuItemLocation, ContentScriptType } from 'api/types';
/*********************************************************
 * 
 
joplin Api文档： https://joplinapp.org/api/references/plugin_api/classes/joplin.html
想做一个joplin的文件加密功能，实现思路
1. 注册一个工具栏的按钮
2. 点击按钮弹出对话框，询问密码
3. 检查这个文件本来有没有密码
	1) 读取joplin的自定义设置
	2) 检查这个note.id 是否有对应的值，有就校验密码，解密；没有就设置密码
4. 加密使用 crypto-js对纯文本的Markdown内容进行加密 https://www.jianshu.com/p/a47477e8126a
5. 同一个文件必须使用同一个密码否则解密失败
6. 给一个清楚所有密码重新输入的按钮（在密码框里输入特定的指令）
ALTER TABLE Production ADD COLUMN NEW Text
*********************************************************/
// AES 纯文本加密
const CryptoJS = require("crypto-js")

/**
 * Overwrite debug with 2 parameter lable, any
 **/
console.debug = (lable:string, obj) => { console.log("NotesEncrypt-Debug(", (new Date()), "):", lable, obj); }

const PREFIX_KEY = "__ENCRYPTNOTE__";
const PREFIX_CRYPT_TYPE = "__?UTF8_AES_CBC128_PKCS7_V101__";
const PREFIX_SPLIT = "__DATA__";

function getAesString(data, key_/*, iv_*/) {//加密
	var key = keyPreprocessor(key_);
	return CryptoJS.AES.encrypt(data, key,
		{
			iv: key,
			mode: CryptoJS.mode.CBC,
			padding: CryptoJS.pad.Pkcs7
		}).toString();
	// let encData = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(encrypted));
	//返回的是base64格式的密文
}
function getDAesString(data, key_/*, iv_*/) {//解密
	var key = keyPreprocessor(key_);
	try{
		var decrypt_data=CryptoJS.AES.decrypt(data, key,
			{
				iv: key,
				mode: CryptoJS.mode.CBC,
				padding: CryptoJS.pad.Pkcs7
			});
		return decrypt_data.toString(CryptoJS.enc.Utf8);
	} catch (exception){
		console.error(exception.description);
		return null;
	}
}

function keyPreprocessor(key_){
	let use_key = key_ + "0000000000000000";
	use_key = use_key.substr(0, 16);
	// console.debug("processed key->", use_key);
	var key = CryptoJS.enc.Utf8.parse(use_key);
	return key;
}
/*
function getAES(data, key) { //加密
	//var iv = 'joplinCryptoJS';// unused parameter
	var encrypted = getAesString(data, key); //密文
	// var encrypted1 =CryptoJS.enc.Utf8.parse(encrypted);
	return encrypted;
}

function getDAes(data, key) {//解密
	//var iv = 'joplinCryptoJS';// unused parameter
	var decryptedStr = getDAesString(data, key);
	console.debug("Daes", data);
	console.debug("Daes", decryptedStr);
	return decryptedStr;
}
*/
joplin.plugins.register({
	onStart: async function () {
		console.log("File encryption runing");
		// 对话框
		const dialogs = joplin.views.dialogs;
		// 询问密码的弹窗
		const encryptDialog = await dialogs.create('encrypt_dialog');
		await dialogs.setHtml(encryptDialog, `
		<p class="fileEncry">Input Your PassWord:(Twice)</p>
		<form name="enc_form" class="fileEncry">
			<input type="password" name="password_input_1" autofocus /><br/><br/>
			Repeat:
			<input type="password" name="password_input_2"/>
		</form>
		`);
		await dialogs.setButtons(encryptDialog, [
			{
				id: 'Encrypt',
			},
			{
				id: 'Cancel',
			}
		]);

		const decryptionDialog = await dialogs.create('decryption_dialog');
		await dialogs.setHtml(decryptionDialog, `
		<p class="fileEncry"> Input Your PassWord:</p>
		<form name="dec_form" class="fileEncry">
			<input type="password" name="dec_password" autofocus />
		</form>
		`);
		await dialogs.setButtons(decryptionDialog, [
			{
				id: 'Decryption',
			},
			{
				id: 'Cancel',
			},
		]);

		const SETTING_SECTION_ID = "settings.notes_encrypt";
		const DISABLE_MOD_ENCRYPTED_ID = "DisableModEncrypted";
		const AUTO_POPUP_ID = "AutoPopup"

		await joplin.settings.registerSection(SETTING_SECTION_ID, { label: "Notes Encrypt", });

		await joplin.settings.registerSettings({
			"AutoPopup": {
				section: SETTING_SECTION_ID,
				label: "Auto Popup",
				type: SettingItemType.Bool,
				value: true,
				public: true,
				description:`When you enter a encrypted note, the decrypt dialog will automatically pop-up.\n\rAlternatively you can click the "lock" button on top-right to decrypt a note.`
			},

			"DisableModEncrypted": {
				section: SETTING_SECTION_ID,
				label: "Disable Modification of Encrypted Note",
				type: SettingItemType.Bool,
				value: true,
				public: true,
				description:`When modification of encrypted notes disabled, every change will be undone immediately.\n\rWarning: modified encrypted text can not be decrypted properly.`,
				advanced:true
			}
		});
		
		const note = await joplin.workspace.selectedNote();
		note.try_number = 0;
		// 上一次加密的时间戳
		//let encrypt_time = (new Date()).valueOf();
		await joplin.commands.register({
			name: 'fileEncry',
			label: 'fileEncry',
			iconName: 'fas fa-lock',
			execute: async () => {
				const note = await joplin.workspace.selectedNote();
				note.try_number = 0;
				//note.is_change = 0;
				cryptCommand(note, "lock_icon_click");
			},

		});



		// 加一个按钮
		await joplin.views.toolbarButtons.create('fileEncry', 'fileEncry', ToolbarButtonLocation.NoteToolbar);
		// await joplin.views.toolbarButtons.create('fileEncry', 'fileEncry', ToolbarButtonLocation.EditorToolbar);

		//var current_note_encrypt = "";
		var currentIsEncrypted = note.body.startsWith(PREFIX_KEY);
		await joplin.workspace.onNoteSelectionChange(async (event: any) => {
			// 当前选中的文件
			try {
				const note = await joplin.workspace.selectedNote();
				// console.debug("note->", note);
				//note.is_change = 0;
				note.try_number = 0;
				checkPrefix(note.body);
				var auto_popup_val = await joplin.settings.value(AUTO_POPUP_ID);
				if (auto_popup_val)
					cryptCommand(note, "onNoteSelectionChange");
			} catch (exception){
				console.error("onNoteSelectionChange");
				console.error(exception.description);
			}

		});
		var command_let_change_flag = false;
		await joplin.workspace.onNoteChange(async (event: any) => {
			const note = await joplin.workspace.selectedNote();
			checkPrefix(note.body);
			/*currentIsEncrypted = note.body.startsWith(PREFIX_KEY)||currentIsEncrypted;
			console.debug("currentIsEncrypted=",currentIsEncrypted);
			console.debug("encrypt_command_flag=",command_let_change_flag);
			if(!currentIsEncrypted) return;
			
			//if (!note.is_change) note.is_change = 0;
			if (command_let_change_flag) {
				note.try_number = 0;
				//note.is_change = 0;
				command_let_change_flag = false;
			} else {
				//note.is_change ++ ;
				//console.debug("note.is_change=",note.is_change);
				cryptCommand(note, "onNoteChange");
			}*/
			
		});

		

		/** 	
		async function codemirror_cmd(cm_cmd, args){
			await joplin.commands.execute('editor.execCommand', {
				name: CODEMIRROR_TOGGLE_COMMAND,
				args: [await joplin.settings.value(SETTING_PREFIX),await joplin.settings.value(SETTING_SUFFIX),toggle()] 
			});
		}
		**/

		/** */
		async function setNote(note:string){
			await joplin.commands.execute("textSelectAll");
			command_let_change_flag = true;
			await joplin.commands.execute("textCut");
			command_let_change_flag = true;
			await joplin.commands.execute("insertText", note);
			
		}

		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			"codemirror_script",
			'./' + "codemirror_script.js"
		);

		async function toggleReadonly(enable:Boolean){
			await joplin.commands.execute('editor.execCommand', {
				name: 'toggleReadonly',
				args: [enable] 
			});
		}


		async function checkPrefix(body:string){
			currentIsEncrypted = body.startsWith(PREFIX_KEY);
			var disable_modify = await joplin.settings.value(DISABLE_MOD_ENCRYPTED_ID);
			toggleReadonly(currentIsEncrypted&&disable_modify);
		}

		async function cryptCommand(note, command) {
			// 尝试次数
			let try_number = note.try_number;
			while (true) {
				if ( currentIsEncrypted ) {
					//文件是加密的
					//如果有改动加密文件，则先执行undo，利用这个阻止修改加密文件，但是在没有安装该插件的软件中是可以修改的
					//不确定修改后能不能解密成功
					/*var disable_modify = await joplin.settings.value(DISABLE_MOD_ENCRYPTED_ID);
					// console.debug("disable_mod_enc->",disable_mod);
					if (disable_modify && command == "onNoteChange"){
						//console.debug("undo process : note.is_change=",note.is_change);
						//if ( note.is_change > 0 ) {
							//note.is_change = 0;
							setNote(current_note_encrypt);
						//};
					}*/
					
					//if(!auto_popup_val && command != "lock_icon_click") return;
					// 解密过程,弹出解密弹窗
					let password_result = await dialogs.open(decryptionDialog);
					if (password_result.id == "Cancel") {
						break;
					} else if (password_result.id == "Decryption") {
						// 有密码且不为空，则解密
						let aes_body = note.body.split(PREFIX_SPLIT)[1]
						let Dbody = getDAesString(aes_body, password_result.formData.dec_form.dec_password)
						// console.debug("aes_body->", aes_body);
						// console.debug("key->", password_result.formData.dec_form.dec_password);
						if (Dbody) {
							// await joplin.data.put(["notes", note.id], null, { body: Dbody })
							// 发现一个新的api可以直接改变note的内容
							// await joplin.commands.execute("editor.setText", Dbody)
							toggleReadonly(false);
							await joplin.commands.execute("textSelectAll");
							await joplin.commands.execute("textCut");
							await joplin.commands.execute("insertText", Dbody);
							currentIsEncrypted = false;
							console.debug("Dbody note->", note);
							break;
						} else {
							// 解密失败，继续弹窗
							try_number += 1;
							continue;
						}
					}

				} else {
					if (command == "onNoteChange") {
						checkPrefix(note.body);
						break;
					}
					// 文件不是加密的，判断调用函数的来源
					if (command != "lock_icon_click") break;
					//来源于按钮，则弹出弹窗

					let password_result = await dialogs.open(encryptDialog);
					if (password_result.id == "Cancel") {
						//如果点击取消
						break;
					} else if ( password_result.id == "Encrypt") {
						if ( password_result.formData.enc_form.password_input_1 == password_result.formData.enc_form.password_input_2 ) {
							//点击加密按钮
							// 没有密码，或者密码为空，则弹出弹窗设置密码，并用密码加密文本
							// console.debug(password_result.id, password_result.formData.enc_form.password_input_1);
							let aes_body = getAesString(note.body, password_result.formData.enc_form.password_input_1);
							// await joplin.data.put(["notes", note.id], null, { body: "[[crypted]]<br>" + aes_body });
							// note.body = "[[crypted]]<br>" + aes_body;
							// 发现一个新的api可以直接改变note的内容
							
							var result = PREFIX_KEY + PREFIX_CRYPT_TYPE + PREFIX_SPLIT + aes_body;

							setNote(result);

							toggleReadonly(true);
							// await joplin.commands.execute("editor.setText","[[crypted]]<br>" + aes_body)
							currentIsEncrypted = true;
							//note.is_change = 0;
							// console.debug("ency->", note);
							//encrypt_time = (new Date()).valueOf();
							break;
						}
					}
				}
			}
		}
	},
});
