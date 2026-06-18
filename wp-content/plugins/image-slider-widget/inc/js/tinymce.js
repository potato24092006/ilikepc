jQuery(document).ready(function($) {
	
			sliderList = jQuery('#ewictinymce_select_slider');
			
			var ewic_H = 365;
			var ewic_W = 550;

// END LOAD MEDIA

	jQuery("body").delegate("#ewic_gut_shorcode-button, #ewicicons_gut_shorcode","click",function(){	
		
			sliderList.find('option').remove();
			jQuery("<option/>").val(0).text('Loading...').appendTo(sliderList);
			
		setTimeout(function() {
			tb_show( '<span style="margin-top: 13px;margin-right: 7px;" class="dashicons dashicons-images-alt2"></span>Shortcode Generator<span class="ewic_cp_version">v'+ewic_tinymce_vars.sc_version+'</span>', '#TB_inline?height='+ewic_H+'&width='+ewic_W+'&inlineId=ewicmodal' );
			jQuery("#TB_window").addClass("TB_ewic_window").css('z-index','999999');
			jQuery("#TB_ajaxContent").addClass("TB_ewic_ajaxContent");
			jQuery(".TB_ewic_ajaxContent").css('height','auto');
			jQuery("select#ewictinymce_select_slider").val("select");
			ewic_H = 365;
			
			$("#TB_closeWindowButton").replaceWith($("<div class='closetb' id='TB_closeWindowButton'><span class='screen-reader-text'>Close</span><span class='tb-close-icon'></span></div>"));
			
			//load ajax to grab slider list ( we need this methode to avoid conflict in media editor with another plugin )
			grabslider();
			ewictbReposition();
			

		}, 300);	
		
	});
	
	// add the shortcode to the post editor
	jQuery('#ewic_insert_scrt').on("click", function () {

		if ( jQuery( "#ewictinymce_select_slider" ).val() != 'select' ) {
		
			var sccode;
			sccode = "[espro-slider id="+jQuery( "#ewictinymce_select_slider option:selected" ).val()+"]";
		
			if( jQuery('#wp-content-editor-container > textarea').is(':visible') ) {
				var val = jQuery('#wp-content-editor-container > textarea').val() + sccode;
				jQuery('#wp-content-editor-container > textarea').val(val);	
				}
				else {
				tinyMCE.activeEditor.execCommand('mceInsertContent', 0, sccode);
					}

			tb_remove();
			}
			else {
				alert('Please select slider first!');
				//tb_remove();
				}
		});	
		
		
		function grabslider() {
			
			sliderList.find('option').remove();
			$("<option/>").val('select').text('- Select Slider -').appendTo(sliderList);
			
			$.each(ewic_tinymce_vars.sliders, function(i, option) {
				$("<option/>").val(option.id).text(option.name).appendTo(sliderList);
			});
			
		}
		
		
		// Reposition Thickbox
		function ewictbReposition() {
			
			$('.TB_ewic_window').css({
				'top' : ((jQuery(window).height() - ewic_H) / 6) + 'px',
				'left' : ((jQuery(window).width() - ewic_W) / 4) + 'px',
				'margin-top' : ((jQuery(window).height() - ewic_H) / 6) + 'px',
				'margin-left' : ((jQuery(window).width() - ewic_W) / 4) + 'px',
				'max-height' : parseInt(ewic_H) + 'px',
				'min-height' : parseInt(ewic_H) + 'px',
			});
				
		}
		
		$(window).resize(function() {
			
			ewictbReposition();
			
		});
		
		// Close Thickbox
		$("body").delegate(".closetb","click",function(){
			
			tb_remove();
			
		});
		
});