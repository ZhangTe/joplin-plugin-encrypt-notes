import joplin from 'api';
import { SettingItemType , ToolbarButtonLocation, MenuItemLocation, ContentScriptType, ModelType } from 'api/types';
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

examples: 
	joplin dialog: https://github.com/laurent22/joplin/blob/dev/packages/app-cli/tests/support/plugins/dialog/src/index.ts

*********************************************************/
// AES 纯文本加密



const CryptoJS = require("crypto-js")

/**
 * Overwrite debug with 2 parameter 
 * @param {string} lable debug title or comment
 * @param {any} obj anything that can be output
 * 
 **/
console.debug = (lable: string, obj: any) => { console.log("NotesEncrypt-Debug(", (new Date()), "):", lable, " -> " ,obj); }

var PREFIX_KEY = ";;ENCRYPTNOTE?";
var PREFIX_CRYPT_TYPE = "UTF8?AES?CBC128?PKCS7?V1101;";
var PREFIX_IV = ";IV;"
var PREFIX_SPLIT = ";DATA;";

/** *
 * regular express :  /^[0-9a-zA-Z \\\[\]\,\.\<\>\?\/\;\:\'\"\|\{\}\+\=-\_\(\)\*\&\^\%\$\#\@\!\~\`]+$/ 
 * 
 * update to: /^[\u0021-\u007E]+$/
 * */
const passwordREG = /^[\u0021-\u007E]+$/
function getAesString(data: string, key_: string) {//encrypt
	var key = keyPreprocessor(key_);

	//AES 128 with 128-bit initializing vector (16 Bytes)
	//Random Generator
	var iv = CryptoJS.lib.WordArray.random(16);
	
	return CryptoJS.AES.encrypt(data, key,
		{
			iv: iv,
			mode: CryptoJS.mode.CBC,
			padding: CryptoJS.pad.Pkcs7
		}).toString() + PREFIX_IV + CryptoJS.enc.Base64.stringify(iv); //Parse iv to string 
	//let encData = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(encrypted));
	//返回的是base64格式的密文
}
function getDAesString(data:string, key_:string, ivs:string):string {//decrypt
	var key = keyPreprocessor(key_);
	try{
		var decrypt_data=CryptoJS.AES.decrypt(data, key,
			{
				iv: (ivs)?CryptoJS.enc.Base64.parse(ivs):key, // for compitability with old version
				mode: CryptoJS.mode.CBC,
				padding: CryptoJS.pad.Pkcs7
			});
		return decrypt_data.toString(CryptoJS.enc.Utf8);
	} catch (exception){
		console.error(exception.description);
		return null;
	}
}

function keyPreprocessor(key_:string):string{
	let use_key = key_ + "0000000000000000";
	use_key = use_key.substr(0, 16);
	// console.debug("processed key->", use_key);
	var key = CryptoJS.enc.Utf8.parse(use_key);
	return key;
}
 
joplin.plugins.register({
	onStart: async function () {
		console.log("File encryption runing");
		// 对话框
		const dialogs = joplin.views.dialogs;
		// 询问密码的弹窗

		const encryptDialog = await dialogs.create('encrypt_dialog');
		const encryptDialogForm = `
		<p class="fileEncry">Encryption Password:</p>
		<form name="enc_form" class="fileEncry">
			<input type="password" name="password_input_1" autofocus /><br/><br/>
			Confirm Password:
			<input type="password" name="password_input_2"/><br>
			<span name="enc_hint">{log}</span>
		</form>
		`
		await dialogs.setHtml(encryptDialog, encryptDialogForm.replace(`{log}`,''));
		await dialogs.setButtons(encryptDialog, [
			{
				id: 'Encrypt',
			},
			/*{
				id: 'Encrypt & Clear History',
			},*/
			{
				id: 'Cancel',
			}
		]);

		const decryptDialogForm = `
		<p class="fileEncry"> Input Your Password:</p>
		<form name="dec_form" class="fileEncry">
			<input type="password" name="dec_password" autofocus />
			<span name="dec_hint">{log}</span>
		</form>
		`

		const decryptDialog = await dialogs.create('decryption_dialog');
		await dialogs.setHtml(decryptDialog, decryptDialogForm.replace(`{log}`,''));
		await dialogs.setButtons(decryptDialog, [
			{
				id: 'Decrypt',
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
		var current_note_backup = "";
		var currentIsEncrypted = note.body.startsWith(PREFIX_KEY);
		var command_let_change_flag = false;
		
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
		
		
		await joplin.workspace.onNoteSelectionChange(async (event: any) => {
			// 当前选中的文件
			try {
				const note = await joplin.workspace.selectedNote();
				// console.debug("note->", note);
				//note.is_change = 0;
				note.try_number = 0;
				checkPrefix(note.body);
				cryptCommand(note, "onNoteSelectionChange");
			} catch (exception){
				console.error("onNoteSelectionChange");
				console.error(exception.description);
			}

		});
		
		await joplin.workspace.onNoteChange(async (event: any) => {
			if (command_let_change_flag) {
				command_let_change_flag = false;
			}
			else {
				const note = await joplin.workspace.selectedNote();
				if (currentIsEncrypted) {
					
						note.try_number = 0;
						cryptCommand(note, "onNoteChange");
					
				} else {
					checkPrefix(note.body);
				}
			}
			
		});

		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			"codemirror_script",
			'./' + "codemirror_script.js"
		);
		/**Codemirror Command Script template */
		/** 	
		async function codemirror_cmd(cm_cmd, args){
			await joplin.commands.execute('editor.execCommand', {
				name: CODEMIRROR_COMMAND,
				args: [param1,param2 ... ] 
			});
		}
		**/
		async function toggleReadonly(enable:Boolean){
			await joplin.commands.execute('editor.execCommand', {
				name: 'toggleReadonly',
				args: [enable] 
			});
		}

		/** */
		async function setNote(note:string){
			
			await joplin.commands.execute("textSelectAll");
			command_let_change_flag = true;
			await joplin.commands.execute("textCut");
			command_let_change_flag = true;
			await joplin.commands.execute("insertText", note);
			 
		}

		/**
		 * Suppose that the text is first time read, when you use this function
		 * variable currentIsEncrypted is not determined before
		 * if need , check currentIsEncrypted ahead the function call.
		 * @param body 
		 */
		async function checkPrefix(body:string){
			//if (currentIsEncrypted) return;
			let tmp = currentIsEncrypted;
			currentIsEncrypted = body.startsWith(PREFIX_KEY);
			var disable_modify = await joplin.settings.value(DISABLE_MOD_ENCRYPTED_ID);
			let toggle = currentIsEncrypted&&disable_modify;
			if (tmp != toggle)
				toggleReadonly(toggle);
			if (currentIsEncrypted)  current_note_backup = body;
		}
 

		async function cryptCommand(note, command) {
			
			let try_number = note.try_number;
			while (true) {
				if ( currentIsEncrypted ) {
					//文件是加密的
					//如果有改动加密文件，则先执行undo，利用这个阻止修改加密文件，但是在没有安装该插件的软件中是可以修改的
					//不确定修改后能不能解密成功
					var disable_modify = await joplin.settings.value(DISABLE_MOD_ENCRYPTED_ID);
				    console.debug("disable_mod_enc->",disable_modify);
					// undo
					if (disable_modify && command == "onNoteChange"){
						//console.debug("undo process : note.is_change=",note.is_change);
						//if ( note.is_change > 0 ) {
							//note.is_change = 0;
							setNote(current_note_backup);
							toggleReadonly(true);
						//};
					}
					
					//if(!auto_popup_val && command != "lock_icon_click") return;
					// 解密过程,弹出解密弹窗
					
					var auto_popup_val = await joplin.settings.value(AUTO_POPUP_ID);
					if (!auto_popup_val && command != "lock_icon_click") break;
					let password_result = await dialogs.open(decryptDialog);
					if (password_result.id == "Cancel") {
						await dialogs.setHtml(decryptDialog, decryptDialogForm.replace(`{log}`,''));
						break;
					} else if (password_result.id == "Decrypt") {
						// 有密码且不为空，则解密
						let aes_body = current_note_backup.split(PREFIX_SPLIT)[1].split(PREFIX_IV);
						// check version
						let aes_iv = '';
						if ( aes_body.length > 1 ) {
							aes_iv = aes_body[1];
						} else {
							aes_iv = null;
						}
						
						let Dbody = getDAesString(aes_body[0], password_result.formData.dec_form.dec_password, aes_iv);
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
							console.debug("Dbody note ", note);
							//hint = "";
							await dialogs.setHtml(decryptDialog, decryptDialogForm.replace(`{log}`,''));
							break;
						} else {
							// 解密失败，继续弹窗
							try_number += 1;
							//hint = "Wrong Password";
							await dialogs.setHtml(decryptDialog, decryptDialogForm.replace(`{log}`,'Wrong password.'));
							continue;
						}
					}

				} else { // not encrypted
					/*if (command == "onNoteChange") { 
						checkPrefix(note.body);
						break;
					}*/
					// 文件不是加密的，判断调用函数的来源
					if (command != "lock_icon_click") break;
					//来源于按钮，则弹出弹窗

					let password_dia = await dialogs.open(encryptDialog);
					if (password_dia.id == "Cancel") {
						//如果点击取消
						console.debug("note id",note.id);
						
						//await joplin.data.get();
						//var a = {replace:(x:string) => ""}; 
						//var rev = await joplin.data.get(['search'], { query:a, type: 'revision' , fields: ['id', 'title_diff'] });

						//var rev = BaseModel.modelSelectAll('SELECT * FROM revisions  ORDER BY item_updated_time ASC', [/*itemType, itemId*/]);

						//await joplin.data.post(path: Path, query?: any, body?: any, files?: any[]): Promise<any>;

					
						//await joplin.data.delete(['revisions',note.id]);

						await dialogs.setHtml(encryptDialog, encryptDialogForm.replace(`{log}`,''));
						break;
					} else { 
						if ( !password_dia.formData.enc_form.password_input_1.match(passwordREG) ) {
							await dialogs.setHtml(encryptDialog, encryptDialogForm.replace(`{log}`,
							password_dia.formData.enc_form.password_input_1 +
							' is not accepted. Password should only contains number, latin letters and basic symbols.'));
							continue;
						}
						if ( password_dia.formData.enc_form.password_input_1 != password_dia.formData.enc_form.password_input_2 ) {
							await dialogs.setHtml(encryptDialog, encryptDialogForm.replace(`{log}`,'Password not match.'));
							continue;
						}
						await dialogs.setHtml(encryptDialog, encryptDialogForm.replace(`{log}`, ''));
						// console.debug(password_result.id, password_result.formData.enc_form.password_input_1);
						let aes_body = getAesString(note.body, password_dia.formData.enc_form.password_input_1);
						// await joplin.data.put(["notes", note.id], null, { body: "[[crypted]]<br>" + aes_body });
						// note.body = "[[crypted]]<br>" + aes_body;
						var result = PREFIX_KEY + PREFIX_CRYPT_TYPE + PREFIX_SPLIT + aes_body;

						
						//if (password_dia.id == "Encrypt & Clear History") {

							// delete current note and post a new blank note with same id and keep some attributes.

							/**
							 * Columns retrieved from sqlite database
							 */
							/*
							var new_note = {
								id: note.id,
								parent_id:note.parent_id,
								title:note.title,
								// body:note.body,
								

								created_time:note.created_time,
								// updated_time:note.updated_time,

								// is_conflict:note.is_conflict,

								latitude:note.latitude,
								longtitude:note.longtitude,
								altitude:note.altitude,
								author:note.author,

								is_todo:note.is_todo,
								todo_due:note.todo_due,
								todo_completed:note.todo_completed,

								source_url:note.source_url,
								source:note.source,
								source_application:note.source_application,
								application_data:note.application_data,

								order:note.order, // ?
								// user_created_time: note.user_created_time,
								// user_updated_time: note.user_updated_time,

								encryption_cipher_text:note.encryption_cipher_text,
								encryption_applied:note.encryption_applied,
								
								markup_language:note.markup_language,
								is_shared:note.is_shared,
								share_id: note.share_id,

								// conflict_original_id:note.conflict_original_id,

								master_key_id:note.master_key_id
							}

							await joplin.data.delete(['notes',note.id]);

							await joplin.data.post(['notes'], null, new_note);

							/** test post
							await joplin.data.post( ['notes'], null, {
								body: "my new note test 1", 
								title: "test title", 
								parent_id:         '6aff869806f442cb9a9a6c6ba1c6195d',
								//[markdown link](:/4ead5085a933445aabf6e9ba901669b1)
								id :               '7dddddc0b3b141f780eff68fdeef73a5'
						   } );**
						    */
							//execute openNote noteid
							//await joplin.commands.execute("openNote",[new_note.id]);
						//}

						// if ( password_dia.id == "Encrypt")
						await setNote(result);
						var disable_modify = await joplin.settings.value(DISABLE_MOD_ENCRYPTED_ID);
						await toggleReadonly(disable_modify);
						current_note_backup = result;
						currentIsEncrypted = true;
						break;
					}
				}
			}
		}

		
	},
});
